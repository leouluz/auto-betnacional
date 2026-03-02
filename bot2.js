import { chromium } from 'playwright';
import { verificarSessao, deslogar, realizarLogin } from './validadeUser.js';

// ─── Constantes ───────────────────────────────────────────────────────────────
const CDP_URL = 'http://localhost:9222';
const DEFAULT_TIMEOUT = 15000;
const APOSTA_TIMEOUT = 60000; // 1 min máximo por aposta
const ENTRE_APOSTAS_MS = 2000;
const MAX_RETRIES = 2;

export default class BetNacionalBot {
  constructor(onEvent) {
    this.page = null;
    this.browser = null;
    this.context = null;
    this.isProcessing = false;
    this.targetUrl = process.env.BET_TARGET_URL || 'https://betnacional.bet.br/events/137/2265/0';
    this.onEvent = onEvent || (() => { });
  }

  // ─── Logger interno ──────────────────────────────────────────────────────────
  log(msg) { this.onEvent('log', msg); }
  error(msg) { this.onEvent('error', msg); }

  // ─── Conexão CDP ──────────────────────────────────────────────────────────────
  async conectar() {
    try {
      this.browser = await chromium.connectOverCDP(CDP_URL);
      const contexts = this.browser.contexts();
      this.context = contexts.length > 0 ? contexts[0] : await this.browser.newContext();
      this.page = this.context.pages().length > 0
        ? this.context.pages()[0]
        : await this.context.newPage();

      this.page.setDefaultTimeout(DEFAULT_TIMEOUT);
    } catch (err) {
      this.error(`❌ Falha na conexão CDP: ${err.message}`);
      throw err; // Propaga para o server.js tratar a reconexão
    }
  }

  // ─── Verifica se a página ainda está viva ────────────────────────────────────
  async paginaEstaViva() {
    try {
      if (!this.page || this.page.isClosed()) return false;
      await this.page.evaluate(() => document.readyState); // ping leve
      return true;
    } catch {
      return false;
    }
  }

  // ─── Garante uma página funcional antes de qualquer operação ─────────────────
  async garantirPagina() {
    if (await this.paginaEstaViva()) return;

    try {
      if (!this.context) throw new Error('Contexto do browser perdido.');
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(DEFAULT_TIMEOUT);
    } catch (err) {
      this.error(`❌ Não foi possível reabrir página: ${err.message}`);
      // Tenta reconectar tudo do zero
      await this.conectar();
    }
  }

  // ─── Navega com retry e validação ────────────────────────────────────────────
  async navegarPara(url, tentativa = 1) {
    try {
      await this.garantirPagina();
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await this.lidarComCookies();
    } catch (err) {
      if (tentativa < MAX_RETRIES) {
        await this.page.waitForTimeout(2000);
        return this.navegarPara(url, tentativa + 1);
      }
      throw new Error(`Falha ao navegar para ${url}: ${err.message}`);
    }
  }

  // ─── Cookies / Overlays ──────────────────────────────────────────────────────
  async lidarComCookies() {
    try {
      const banner = this.page.locator('#cookiescript_injected');
      const visivel = await banner.isVisible({ timeout: 2000 }).catch(() => false);
      if (!visivel) return; // Sem banner, nada a fazer


      // Passo 1: tenta clicar em Aceitar
      const btnAccept = this.page.locator('#cookiescript_accept');
      if (await btnAccept.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btnAccept.click().catch(() => { });
        // Aguarda até 2s para o banner sumir sozinho após o clique
        await banner.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => { });
      }

      // Passo 2: se ainda estiver visível, remove via DOM
      const aindaVisivel = await banner.isVisible({ timeout: 500 }).catch(() => false);
      if (aindaVisivel) {
        await this.page.evaluate(() => {
          document.getElementById('cookiescript_injected')?.remove();
          // Remove também possíveis overlays/backdrops deixados pelo banner
          document.querySelectorAll('[class*="cookiescript"]').forEach(el => el.remove());
        });
        // Pequena pausa para o DOM estabilizar após a remoção
        await this.page.waitForTimeout(300);
      }

    } catch { /* Silencioso — cookie banner é opcional */ }
  }

  // ─── Validação de horário (limite 2 min após início) ─────────────────────────
  validarHorarioJogo(matchText) {
    try {
      const lines = matchText.split('\n');
      const dateLine = lines.find(l => l.includes('Data:'));
      if (!dateLine) return true; // Sem data = deixa passar

      // Formato esperado: "Data: 23/02/2026 - 15:00"
      const match = dateLine.match(/(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}:\d{2})/);
      if (!match) {
        this.error(`⚠️ Formato de data inválido: "${dateLine}"`);
        return false;
      }

      const [dia, mes, ano] = match[1].split('/').map(Number);
      const [hora, min] = match[2].split(':').map(Number);
      const inicioJogo = new Date(ano, mes - 1, dia, hora, min);
      const diffMinutos = (Date.now() - inicioJogo.getTime()) / 60000;

      // Tolerância: até 3 min após o início do jogo
      // ex: jogo 12:00 → aceita até 12:02:59, recusa a partir de 12:03:00
      if (diffMinutos < 0) {
        // Jogo ainda não começou — aceita normalmente
        return true;
      }

      if (diffMinutos > 3) {
        this.onEvent('missed', {
          user: 'sistema',
          match: matchText.split('\n').find(l => l.includes('Jogo:')) || matchText.split('\n')[0],
          reason: `Fora do prazo: jogo iniciou há ${Math.floor(diffMinutos)} min (limite: 3 min)`
        });
        return false;
      }

      return true;
    } catch (err) {
      this.error(`Erro ao validar horário: ${err.message}`);
      return false;
    }
  }

  // ─── Conversão de saldo ───────────────────────────────────────────────────────
  converterSaldoParaNumero(saldoTexto) {
    if (!saldoTexto) return 0;
    return parseFloat(
      saldoTexto.replace(/R\$\s?/, '').replace(/\./g, '').replace(',', '.').trim()
    ) || 0;
  }

  // ─── Faixas de valor por saldo ────────────────────────────────────────────────
  calcularValorAposta(saldo) {
    const faixas = [
      { min: 401, val: '30.00' }, { min: 301, val: '25.00' }, { min: 251, val: '20.00' },
      { min: 141, val: '5.00' },
      { min: 121, val: '5.00' }, { min: 101, val: '3.00' }, { min: 81, val: '3.00' },
      { min: 51, val: '3.00' }, { min: 31, val: '2.00' }, { min: 10, val: '1.00' },
    ];
    return faixas.find(f => saldo >= f.min)?.val ?? null;
  }

  // ─── Parser de mensagem ──────────────────────────────────────────────────────
  // O sinal do Telegram vem como: "Jogo: Crysis x Banega" (só apelidos)
  // O site exibe o texto: "Bayer 04 Leverkusen (Crysis) x Chelsea FC (Banega)"
  // Guardamos o apelido puro para filtrar o row pelo texto do site.
  parsearMensagem(matchText) {
    try {
      const lines = matchText.split('\n').map(l => l.trim()).filter(Boolean);
      const matchLine = lines.find(l => /jogo:/i.test(l));
      if (!matchLine) return null;

      // Última linha não vazia = favorito
      const favoriteRaw = lines[lines.length - 1].toLowerCase();
      const favoriteCleanEarly = favoriteRaw.replace(/[^a-z0-9]/g, '');
      const isGols = favoriteCleanEarly.includes('over') || favoriteCleanEarly.includes('under');

      // Detecta handicap: favoriteRaw começa com número (ex: "0.25 banega", "-1 eros", "0 banega")
      // Regex: opcional sinal negativo, dígitos, opcional decimal — antes do nome do jogador
      const handicapMatch = favoriteRaw.match(/^[^\d-]*(-?\d+(?:\.\d+)?)\s+(\S+)/);
      const isHandicap = !isGols && handicapMatch !== null;
      const hcpValor = isHandicap ? parseFloat(handicapMatch[1]) : null;   // ex: -0.25, 0, 0.25
      const hcpJogador = isHandicap ? handicapMatch[2].replace(/[^a-z]/g, '') : null; // ex: "banega"
      const hcpPositivo = isHandicap && hcpValor >= 0; // 0 e positivos = coluna (+), negativos = coluna (-)

      const jogoStr = matchLine.split(/jogo:/i)[1]?.trim();
      if (!jogoStr) return null;

      const partes = jogoStr.split(/\s+x\s+/i);
      if (!partes || partes.length < 2) return null;

      // Extrai apelido: "Bayer 04 Leverkusen (Crysis)" → "crysis"
      // Sem parênteses: "Crysis" → "crysis"
      const extrairApelido = (t) => {
        t = t.trim();
        const m = t.match(/\(([^)]+)\)/);
        return (m ? m[1] : t).trim().toLowerCase();
      };

      const p1 = extrairApelido(partes[0]);
      const p2 = extrairApelido(partes[1]);

      if (!p1 || !p2) return null;

      const tipo = isGols ? 'gols' : isHandicap ? `handicap(${hcpValor} ${hcpJogador})` : 'vitória';

      // favoriteClean = favoriteCleanEarly (já calculado acima)
      const favoriteClean = favoriteCleanEarly;

      return { matchLine, favoriteRaw, favoriteClean, isGols, isHandicap, hcpValor, hcpJogador, hcpPositivo, p1, p2 };
    } catch (err) {
      this.error(`Erro ao parsear mensagem: ${err.message}`);
      return null;
    }
  }

  // ─── Processamento do lote por conta ─────────────────────────────────────────
  async processarLoteDeApostas(mensagens, accounts) {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    for (const acc of (accounts || [])) {
      try {
        await this.processarContaComTimeout(acc, mensagens);
      } catch (err) {
        // Erro em UMA conta não para as outras
        this.error(`❌ Conta ${acc.user} falhou e foi pulada: ${err.message}`);
      }
    }

    this.isProcessing = false;
  }

  // ─── Processa uma conta com timeout global ────────────────────────────────────
  async processarContaComTimeout(acc, mensagens) {
    const TIMEOUT_CONTA = 5 * 60 * 1000; // 5 min por conta no máximo

    const trabalho = this._processarConta(acc, mensagens);
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout de 5 min atingido para conta ${acc.user}`)), TIMEOUT_CONTA)
    );

    await Promise.race([trabalho, timeout]);
  }

  async _processarConta(acc, mensagens) {
    await this.navegarPara(this.targetUrl);
    await deslogar(this.page);

    const logado = await realizarLogin(this.page, acc.user, acc.pass);
    if (!logado) {
      this.error(`⚠️ Login falhou para ${acc.user}. Pulando conta.`);
      return;
    }

    const info = await verificarSessao(this.page);
    const saldo = this.converterSaldoParaNumero(info?.saldo);
    const valor = this.calcularValorAposta(saldo);

    this.onEvent('balance', { user: acc.user, balance: info?.saldo ?? 'N/D' });

    if (!valor) {
      return;
    }


    // Set de deduplicação por conta — reseta a cada conta para que conta B
    // possa apostar nos mesmos jogos que conta A apostou, mas NUNCA repete
    // o mesmo sinal duas vezes na mesma conta.
    const apostasNoLote = new Set();

    for (const msg of mensagens) {
      try {
        await this.executarApostaSingularComTimeout(msg, valor, acc, apostasNoLote);
        await this.page.waitForTimeout(ENTRE_APOSTAS_MS);
      } catch (err) {
        // Erro em UMA aposta não para as outras apostas da mesma conta
        this.error(`⚠️ Aposta pulada em ${acc.user}: ${err.message}`);
      }
    }
  }

  // ─── Aposta com timeout individual ───────────────────────────────────────────
  async executarApostaSingularComTimeout(matchText, valor, account, apostasNoLote) {
    const trabalho = this._executarAposta(matchText, valor, account, apostasNoLote);
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout de 60s na execução da aposta')), APOSTA_TIMEOUT)
    );
    await Promise.race([trabalho, timeout]);
  }

  async _executarAposta(matchText, valor, account, apostasNoLote) {
    // 1. Validação de tempo
    if (!this.validarHorarioJogo(matchText)) return;

    // 2. Parse da mensagem
    const parsed = this.parsearMensagem(matchText);
    if (!parsed) {
      this.error(`⚠️ Mensagem inválida, não foi possível parsear: "${matchText.split('\n')[0]}"`);
      return;
    }

    const { matchLine, favoriteRaw, favoriteClean, isGols, isHandicap, hcpValor, hcpJogador, hcpPositivo, p1, p2 } = parsed;

    // 3. Deduplicação — chave usa p1+p2+favoriteRaw COMPLETO (preserva números como 0.5, 4.25)
    // Assim "under 4.25 david" e "under 0.5 david" são sinais DISTINTOS,
    // mas o mesmo sinal exato não é apostado duas vezes na mesma conta.
    const apostaId = `${p1}|${p2}|${favoriteRaw.trim()}`;
    if (apostasNoLote.has(apostaId)) {
      return;
    }
    apostasNoLote.add(apostaId);

    // 4. Filtros de estratégia da conta — cada tipo tem seu próprio toggle
    // enableHandicap usa ?? true para compatibilidade com contas antigas sem o campo
    if (isGols && !account.enableGols) { return; }
    if (isHandicap && !(account.enableHandicap ?? true)) { return; }
    if (!isGols && !isHandicap && !account.enableVitoria) { return; }

    // 4. Navega para a lista de jogos
    await this.navegarPara(this.targetUrl);

    // 5. Aguarda os cards de jogos carregarem (igual ao código original que funciona)
    await this.page.waitForSelector('[data-testid="preMatchOdds"]', { timeout: 10000 }).catch(() => {
    });

    // 6. Localiza a linha do jogo filtrando pelo apelido (p1/p2)
    const row = this.page
      .locator('[data-testid="preMatchOdds"]')
      .filter({ hasText: new RegExp(p1, 'i') })
      .filter({ hasText: new RegExp(p2, 'i') })
      .first();

    const jogoVisivel = await row.isVisible({ timeout: 8000 }).catch(() => false);
    if (!jogoVisivel) {
      this.onEvent('missed', { user: account.user, match: matchLine, reason: 'Jogo não encontrado na lista' });
      return;
    }

    // 6 + 7. Fluxo por tipo de aposta: GOLS / HANDICAP / VITÓRIA

    if (isGols) {
      // ── GOLS ─────────────────────────────────────────────────────────────────
      await row.locator('a[href*="/event/"]').first().click();
      await this.page.waitForLoadState('domcontentloaded');

      const suffixGols = favoriteClean.includes('over') ? '_18_12_' : '_18_13_';
      await this.page.locator(`div[data-testid*="${suffixGols}"]`).first().click();

    } else if (isHandicap) {
      // ── HANDICAP ASIÁTICO ────────────────────────────────────────────────────
      // Abre a página interna do evento (igual ao fluxo de gols)
      await row.locator('a[href*="/event/"]').first().click();
      await this.page.waitForLoadState('domcontentloaded');


      // Aguarda a seção "Handicap Asiático" aparecer na página
      await this.page.waitForSelector('[data-testid="outcomes-by-market"]', { timeout: 10000 })
        .catch(() => { });

      // Estratégia de busca:
      // O site mostra "Nome (Banega) (+0.75)" ou "Nome (Banega) (-0.75)" no span interno.
      // Filtramos pelo apelido do jogador (hcpJogador) E pelo sinal (+/-) usando
      // data-testid do hcp= como âncora, sem regex com caracteres especiais não escapados.
      //
      // hcpPositivo = true  → sinal é (+X) no texto → coluna da esquerda
      // hcpPositivo = false → sinal é (-X) no texto → coluna da direita
      //
      // Usamos hcpPositivo para escolher a coluna via nth(0) ou nth(1),
      // filtrando primeiro pelo jogador para garantir o row correto.

      // Todos os divs de handicap desta página
      const todasOddsHcp = this.page.locator('div[data-testid*="_16_"][data-testid*="hcp="]');

      // Filtra pelo apelido do jogador no texto visível do span
      const oddsDoJogador = todasOddsHcp.filter({ hasText: new RegExp(hcpJogador, 'i') });
      const qtd = await oddsDoJogador.count().catch(() => 0);


      let oddHandicap;

      if (qtd === 0) {
        // Jogador não encontrado pelo apelido — tenta pelo data-testid do hcp
        // O value hcp= no testid reflete o valor atribuído ao TIME 1 (coluna esquerda)
        // Se hcpPositivo, o jogador está na coluna esquerda (índice 0), senão direita (índice 1)
        oddHandicap = todasOddsHcp.nth(hcpPositivo ? 0 : 1);
      } else if (qtd === 1) {
        // Só um elemento com o jogador — usa direto
        oddHandicap = oddsDoJogador.first();
      } else {
        // Mais de um (ex: mesmo apelido nos dois lados) — escolhe pelo sinal no texto
        // Escapa caracteres especiais de regex manualmente
        const sinalEscapado = hcpPositivo ? '\(\+' : '\(-';
        oddHandicap = oddsDoJogador.filter({ hasText: new RegExp(sinalEscapado, 'i') }).first();
      }

      const hcpVis = await oddHandicap.isVisible({ timeout: 8000 }).catch(() => false);

      if (!hcpVis) {
        const sinalLabel = hcpPositivo ? '+' : '-';
        this.onEvent('missed', { user: account.user, match: matchLine, reason: `Odd handicap não encontrada (${hcpJogador} ${sinalLabel}${Math.abs(hcpValor)})` });
        this.error(`⚠️ Odd handicap não encontrada para "${hcpJogador}" (${sinalLabel}${Math.abs(hcpValor)})`);
        return;
      }

      await oddHandicap.click();

    } else {
      // ── VITÓRIA ──────────────────────────────────────────────────────────────
      const temOddAtiva = await row.locator('div[data-testid^="odd-"]').first()
        .isVisible({ timeout: 3000 }).catch(() => false);

      if (!temOddAtiva) {
        this.onEvent('missed', { user: account.user, match: matchLine, reason: 'Odds suspensas ou indisponíveis na lista' });
        return;
      }

      const isT2 = favoriteClean.includes(p2) || p2.includes(favoriteClean);
      const suffixVit = isT2 ? '_1_3_' : '_1_1_';


      const mercado = row.locator(`div[data-testid$="${suffixVit}"]`).first();
      const mercVis = await mercado.isVisible({ timeout: 8000 }).catch(() => false);

      if (!mercVis) {
        const suffixAlt = isT2 ? '_1_1_' : '_1_3_';
        const mercAlt = row.locator(`div[data-testid$="${suffixAlt}"]`).first();
        const altVis = await mercAlt.isVisible({ timeout: 3000 }).catch(() => false);

        if (!altVis) {
          this.onEvent('missed', { user: account.user, match: matchLine, reason: `Odd de vitória (${suffixVit}) não encontrada` });
          this.error(`⚠️ Odd de vitória não encontrada para ${p1} x ${p2}`);
          return;
        }

        await mercAlt.scrollIntoViewIfNeeded().catch(() => { });
        await mercAlt.click({ force: true });
      } else {
        await mercado.scrollIntoViewIfNeeded().catch(() => { });
        await mercado.click({ force: true });
      }
    }

    // 7. Confirma no cupom
    await this.confirmarNoCupom(valor, account.user, matchLine);
  }

  // ─── Confirmação no cupom de apostas ─────────────────────────────────────────
  async confirmarNoCupom(valor, usuario, jogo) {
    try {
      // 1. Remove cookie banner ANTES de tentar qualquer interação com o cupom
      //    O banner fica na frente do input e impede o waitFor de encontrá-lo
      await this.lidarComCookies();

      // 2. Tenta expandir o cupom se estiver colapsado
      const headerSimples = this.page.locator('div[data-testid="betslip-container"] >> text="Simples"').first();
      if (await headerSimples.isVisible({ timeout: 3000 }).catch(() => false)) {
        await headerSimples.click();
        await this.page.waitForTimeout(800);
        // Remove cookie que pode ter reaparecido após a interação
        await this.lidarComCookies();
      }

      // 3. Aguarda o input de valor aparecer (até 6s)
      const inputValor = this.page.locator('input.is_CurrencyField').first();
      let inputOk = await inputValor.isVisible({ timeout: 6000 }).catch(() => false);

      // 3b. Se ainda não apareceu, faz uma última limpeza de cookie e tenta de novo
      if (!inputOk) {
        await this.lidarComCookies();
        inputOk = await inputValor.isVisible({ timeout: 4000 }).catch(() => false);
      }

      if (!inputOk) {
        await this.page.screenshot({ path: `debug_input_${usuario}_${Date.now()}.png` }).catch(() => { });
        this.error(`⚠️ Input de valor não apareceu para ${usuario} após todas as tentativas.`);
        return;
      }

      // 4. Preenche o valor
      await inputValor.fill('');
      await inputValor.fill(valor);

      // 5. Clica em Apostar se habilitado
      const btnApostar = this.page.locator('button:has(span:text("Apostar"))').first();
      if (await btnApostar.isEnabled({ timeout: 5000 }).catch(() => false)) {
        await btnApostar.click();
        this.onEvent('bet', { user: usuario, match: jogo, side: 'Confirmada', value: `R$ ${valor}` });
      } else {
        await this.page.screenshot({ path: `debug_btn_${usuario}_${Date.now()}.png` }).catch(() => { });
      }

    } catch (err) {
      this.error(`⚠️ Erro no cupom (${usuario}): ${err.message}`);
      await this.page.screenshot({ path: `erro_cupom_${usuario}_${Date.now()}.png` }).catch(() => { });
    }
  }
}