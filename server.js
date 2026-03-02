import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import crypto from 'crypto';

import BetNacionalBot from './bot2.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const LAST_MESSAGE_FILE = path.join(__dirname, 'last_message_id.json');

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// ─── Estado Global ────────────────────────────────────────────────────────────
let isRunning = false;
let cycleCount = 0;
let lastSuccessfulCycle = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

// Conexão CDP persistente do monitor — criada uma vez, reutilizada em todos os ciclos.
// Evita o leak de objetos Playwright que causava OOM após horas de execução.
let monitorBrowser = null;
let monitorContext = null;
let monitorPage = null;   // aba do Telegram

// ─── Bot ──────────────────────────────────────────────────────────────────────
const betBot = new BetNacionalBot((type, data) => {
  const payload = { type, data, time: new Date().toLocaleTimeString('pt-BR') };
  if (type === 'balance') io.emit('balanceUpdate', data);
  if (type === 'log') io.emit('newLog', payload);
  if (type === 'error') io.emit('newError', payload);
  if (type === 'bet') io.emit('newBet', payload);
  if (type === 'missed') io.emit('newMissed', payload);
});

// ─── Utilitários ──────────────────────────────────────────────────────────────
function hashMessage(msg) {
  return crypto.createHash('md5').update(msg.trim()).digest('hex');
}

function normalize(text) {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function emitLog(msg) {
  // Mantido para o dashboard — sem saída no console
  const payload = { type: 'log', data: msg, time: new Date().toLocaleTimeString('pt-BR') };
  io.emit('newLog', payload);
}

function emitError(msg, ciclo = null) {
  const hora = new Date().toLocaleTimeString('pt-BR');
  const prefix = ciclo != null ? `[CICLO #${ciclo} | ${hora}]` : `[${hora}]`;
  const payload = { type: 'error', data: msg, time: hora };
  io.emit('newError', payload);
  console.error(`${prefix} ${msg}`);
}

// ─── Leitura de Arquivo com fallback seguro ───────────────────────────────────
async function readJSON(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// ─── Extração de Mensagens do Telegram ───────────────────────────────────────
async function extractMessages(page) {
  try {
    if (!page || page.isClosed()) {
      emitError('Página do Telegram está fechada ou inválida.');
      return [];
    }

    await page.waitForSelector('.bubble.channel-post', { timeout: 10000 });

    return await page.$$eval('.bubble.channel-post .translatable-message', els =>
      els.map(el => {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('img, span').forEach(n => {
          const emoji = n.getAttribute('alt') || n.getAttribute('aria-label');
          if (emoji) n.replaceWith(emoji);
        });
        return clone.innerText.trim();
      })
    );
  } catch (e) {
    // Não é erro crítico — pode ser que não haja mensagens na tela ainda
    return [];
  }
}

// ─── Conexão persistente do monitor (Telegram) ───────────────────────────────
// Cria ou reutiliza a conexão CDP do monitor. Se a página morreu, reconecta.
async function obterPaginaTelegram() {
  const chatHash = process.env.HOME_CHAT_ID;
  const telegramUrl = `${process.env.TELEGRAM_URL}#${chatHash}`;

  // Tenta reutilizar página existente
  if (monitorPage && !monitorPage.isClosed()) {
    try {
      await monitorPage.evaluate(() => document.readyState); // ping
      return monitorPage;
    } catch {
      monitorPage = null;
    }
  }

  // Tenta reutilizar conexão CDP
  if (!monitorBrowser) {
    monitorBrowser = await chromium.connectOverCDP('http://localhost:9222');
    monitorContext = monitorBrowser.contexts()[0];
    if (!monitorContext) throw new Error('Nenhum contexto CDP disponível para o monitor.');
  }

  // Procura aba do Telegram já aberta
  const pages = monitorContext.pages();
  monitorPage = pages.find(p => p.url().includes(chatHash)) ?? null;

  if (!monitorPage) {
    monitorPage = await monitorContext.newPage();
    await monitorPage.goto(telegramUrl, { waitUntil: 'domcontentloaded' });
    await monitorPage.waitForTimeout(4000);
  } else {
    await monitorPage.bringToFront().catch(() => { });
  }

  return monitorPage;
}

// ─── Reconexão do Bot com reinicialização segura ──────────────────────────────
async function reconnectBot() {
  try {
    await betBot.conectar();
    consecutiveErrors = 0;
  } catch (err) {
    emitError(`Falha na reconexão do bot: ${err.message}`);
  }
}

// ─── Processamento de Apostas com Timeout Global ─────────────────────────────
async function processarComTimeout(mensagens, accounts) {
  // Timeout dinâmico: 90s base + 45s por aposta (sinais × contas)
  // Exemplos:
  //   1 sinal × 2 contas  =  90 + 90  = 3 min
  //   6 sinais × 2 contas =  90 + 540 = 10.5 min
  //  10 sinais × 2 contas =  90 + 900 = 16.5 min
  const totalApostas = mensagens.length * (accounts?.length || 1);
  const TIMEOUT_MS = (90 + totalApostas * 45) * 1000;

  const promessa = betBot.processarLoteDeApostas(mensagens, accounts);
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout: processamento do lote excedeu ${Math.round(TIMEOUT_MS / 60000 * 10) / 10} min`)), TIMEOUT_MS)
  );

  await Promise.race([promessa, timeout]);
}

// ─── Ciclo Principal de Automação ────────────────────────────────────────────
async function runAutomation() {
  // Proteção 1: ciclo de monitoramento já está rodando
  if (isRunning) {
    return;
  }

  // Proteção 2: bot ainda está processando apostas
  // CRÍTICO: não conectar ao Chrome enquanto o bot usa o browser,
  // pois duas conexões CDP simultâneas corrompem a navegação e quebram o login
  if (betBot.isProcessing) {
    return;
  }

  isRunning = true;
  cycleCount++;
  const cicloAtual = cycleCount;


  try {
    // ── 1. Carrega dados persistidos ──────────────────────────────────────────
    const sent = await readJSON(LAST_MESSAGE_FILE, []);
    const accounts = await readJSON(ACCOUNTS_FILE, []);

    if (accounts.length === 0) {
      return;
    }

    // ── 2+3. Obtém página do Telegram via conexão persistente ─────────────────
    // A conexão é criada uma única vez e reutilizada, evitando leak de memória.
    let page;
    try {
      page = await obterPaginaTelegram();
    } catch (err) {
      // Se falhar, invalida conexão para forçar nova tentativa no próximo ciclo
      monitorBrowser = null; monitorContext = null; monitorPage = null;
      throw new Error(`Falha ao obter página do Telegram: ${err.message}`);
    }

    // ── 4. Lê as mensagens ───────────────────────────────────────────────────
    const messages = await extractMessages(page);

    // ── 5. Filtra apenas mensagens novas e válidas ───────────────────────────
    const loteDeMensagens = [];

    for (const msg of messages) {
      const clean = normalize(msg);
      if (clean.includes('Resultado') || !clean.includes('Jogo:')) continue;

      const hash = hashMessage(clean);
      if (sent.includes(hash)) continue;

      loteDeMensagens.push(clean);
      sent.push(hash);
    }

    // ── 6. Processa as apostas (com timeout para não travar o ciclo) ─────────
    if (loteDeMensagens.length > 0) {

      try {
        await processarComTimeout(loteDeMensagens, accounts);
      } catch (botErr) {
        // ❗ Erro do bot NÃO derruba o ciclo — apenas loga e continua
        emitError(`Erro no processamento das apostas: ${botErr.message}`, cicloAtual);

        // Marca para reconectar o bot antes do próximo ciclo
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          emitError(`${MAX_CONSECUTIVE_ERRORS} erros consecutivos. Forçando reconexão...`, cicloAtual);
          await reconnectBot();
        }
      }
    } else {
    }

    // ── 7. Persiste o histórico de hashes (mantém os últimos 300) ───────────
    await fs.writeFile(LAST_MESSAGE_FILE, JSON.stringify(sent.slice(-300), null, 2));

    // ── 8. Atualiza estado de sucesso ────────────────────────────────────────
    lastSuccessfulCycle = new Date();
    consecutiveErrors = 0;

  } catch (err) {
    // Erros de infraestrutura (CDP, arquivo, etc.) chegam aqui
    consecutiveErrors++;
    emitError(`Erro de infraestrutura: ${err.message}`, cicloAtual);

    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      emitError(`Muitos erros consecutivos. Reconectando bot...`, cicloAtual);
      await reconnectBot();
    }
  } finally {
    isRunning = false;
  }
}

// ─── Endpoints REST ───────────────────────────────────────────────────────────
app.get('/api/accounts', async (req, res) => {
  const data = await readJSON(ACCOUNTS_FILE, []);
  // Nunca retorna senhas para o frontend
  const safe = data.map(({ user, enableGols, enableVitoria, enableHandicap }) => ({ user, enableGols, enableVitoria, enableHandicap: enableHandicap ?? true }));
  res.json(safe);
});

app.post('/api/accounts', async (req, res) => {
  try {
    const { user, pass, enableGols = true, enableVitoria = true, enableHandicap = true } = req.body;
    if (!user || !pass) return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });

    const accounts = await readJSON(ACCOUNTS_FILE, []);
    if (accounts.find(a => a.user === user)) {
      return res.status(409).json({ error: 'Conta já cadastrada.' });
    }

    accounts.push({ user, pass, enableGols, enableVitoria, enableHandicap });
    await fs.writeFile(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Rota PATCH — alterna enableVitoria ou enableGols de uma conta
app.patch('/api/accounts/:user/toggle', async (req, res) => {
  try {
    const { tipo } = req.body; // 'vitoria' ou 'gols'
    if (!['vitoria', 'gols'].includes(tipo)) {
      return res.status(400).json({ error: 'tipo deve ser "vitoria" ou "gols".' });
    }

    const accounts = await readJSON(ACCOUNTS_FILE, []);
    const acc = accounts.find(a => a.user === req.params.user);
    if (!acc) return res.status(404).json({ error: 'Conta não encontrada.' });

    if (tipo === 'vitoria') acc.enableVitoria = !acc.enableVitoria;
    if (tipo === 'gols') acc.enableGols = !acc.enableGols;
    if (tipo === 'handicap') acc.enableHandicap = !(acc.enableHandicap ?? true);

    await fs.writeFile(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
    res.json({ user: acc.user, enableVitoria: acc.enableVitoria, enableGols: acc.enableGols, enableHandicap: acc.enableHandicap ?? true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Rota DELETE que estava faltando no original
app.delete('/api/accounts/:user', async (req, res) => {
  try {
    const accounts = await readJSON(ACCOUNTS_FILE, []);
    const filtradas = accounts.filter(a => a.user !== req.params.user);
    await fs.writeFile(ACCOUNTS_FILE, JSON.stringify(filtradas, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/run', (req, res) => {
  runAutomation();
  res.json({ status: 'Ciclo disparado manualmente.' });
});

// Endpoint de status para monitorar a saúde do sistema
app.get('/api/status', (req, res) => {
  res.json({
    isRunning,
    cycleCount,
    consecutiveErrors,
    lastSuccessfulCycle,
    botProcessing: betBot.isProcessing,
  });
});

// ─── Inicialização ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log(`🚀 MONITOR RODANDO EM: http://localhost:${PORT}`);

  await betBot.conectar();

  // Primeiro ciclo imediato
  runAutomation();

  // Ciclos a cada 30 segundos
  // O isRunning garante que ciclos não se sobrepõem mesmo se um demorar mais
  setInterval(runAutomation, 100000);
});