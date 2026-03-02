import { chromium } from 'playwright';

/**
 * Função para verificar o saldo e status de login
 */
export async function verificarSessao(page) {
  try {
    await page.waitForTimeout(3000);

    return await page.evaluate(() => {
      const regexSaldo = /R\$\s?(\d{1,3}(\.\d{3})*,\d{2})/;
      const bodyText = document.body.innerText;
      const matches = bodyText.match(regexSaldo);

      const saldo = matches ? matches[0] : "R$ 0,00";
      const temBotaoDepositar = bodyText.toLowerCase().includes('depositar');
      const temBotaoPerfil = !!document.querySelector('[data-testid*="user-profile-button"]');

      return {
        logado: temBotaoDepositar || temBotaoPerfil,
        saldo: saldo
      };
    });
  } catch (error) {
    return { logado: false, saldo: "R$ 0,00" };
  }
}

/**
 * Função para deslogar o usuário atual
 */
export async function deslogar(page) {
  try {
    const status = await verificarSessao(page);
    if (!status.logado) return true;

    const perfilBtn = page.locator('[data-testid*="user-profile-button"]').first();
    await perfilBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1000);

    const botaoSair = page.locator('button:has-text("Sair"), [data-testid*="logout"]').last();
    await botaoSair.click();

    await page.waitForSelector('button:has-text("Entrar")', { timeout: 8000 }).catch(() => { });
    return true;
  } catch (error) {
    await page.context().clearCookies();
    await page.reload();
    return false;
  }
}

/**
 * Função interna de execução do login (a lógica pura)
 */
async function executarLogicaLogin(page, user, pass) {
  // 1. Abre o modal de login se não estiver visível
  const campoCPF = page.getByPlaceholder(/CPF|Usuário/i);
  if (!(await campoCPF.isVisible())) {
    const btnEntrar = page.locator('button:has-text("Entrar")').first();
    await btnEntrar.click();
    await page.waitForTimeout(1500);
  }

  await campoCPF.waitFor({ state: 'visible' });

  // 2. Digitação simulada
  await campoCPF.click();
  await campoCPF.fill('');
  await campoCPF.pressSequentially(user, { delay: 120 });

  const campoSenha = page.getByPlaceholder(/Senha/i);
  await campoSenha.click();
  await campoSenha.fill('');
  await campoSenha.pressSequentially(pass, { delay: 120 });

  await page.waitForTimeout(1000);

  const btnSubmit = page.locator('button[type="submit"]').filter({ hasText: /^Entrar$/ }).first();

  // 3. Forçar habilitação do botão se necessário
  if (await btnSubmit.getAttribute('aria-disabled') === 'true' || await btnSubmit.isDisabled()) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);
  }

  // 4. Clique e espera
  await btnSubmit.click({ timeout: 12000 });

  // 5. Verificação final de sucesso
  await page.waitForFunction(() => {
    return document.body.innerText.includes('R$') ||
      document.body.innerText.includes('Depositar') ||
      !!document.querySelector('[data-testid*="user-profile-button"]');
  }, { timeout: 15000 });

  return true;
}

/**
 * Função principal para logar com sistema de Re-tentativa
 */
export async function realizarLogin(page, user, pass) {
  try {
    // TENTATIVA 1
    return await executarLogicaLogin(page, user, pass);
  } catch (error) {
    console.log(`⚠️ Falha na primeira tentativa de login para ${user}. Tentando recarregar...`);

    try {
      // RESET PARA TENTATIVA 2
      await page.context().clearCookies(); // Limpa rastros
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      // TENTATIVA 2
      return await executarLogicaLogin(page, user, pass);
    } catch (error2) {
      console.error(`❌ Falha definitiva ao logar com ${user} após re-tentativa.`);
      await page.screenshot({ path: `erro_login_final_${user}.png` }).catch(() => { });
      return false; // Segue o fluxo (próxima conta)
    }
  }
}