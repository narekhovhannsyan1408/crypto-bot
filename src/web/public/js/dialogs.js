// Диалоги запуска и остановки бота.

import { api } from './api.js';
import {
  escapeHtml,
  fmtMoney,
  fmtSignedMoney,
  shortAddress,
} from './format.js';
import { t, th, tm } from './i18n.js';

const $ = (id) => document.getElementById(id);

const AUTO_STOP_OPTIONS = [0, 0.2, 0.3, 0.4];
const DEFAULT_AUTO_STOP = 0.3;
const REAL_MODES = new Set(['live_real', 'solana_real']);
// Режимы с внешним счётом: перед запуском показываем свободный баланс
const ACCOUNT_MODES = new Set(['live_testnet', 'live_real', 'solana_real']);

/**
 * @param {{ getApp: () => any, onChanged: (state: any) => void, toast: (message: string) => void }} deps
 */
export function createDialogs({ getApp, onChanged, toast }) {
  const start = {
    dialog: $('start-dialog'),
    title: $('start-dialog-title'),
    content: $('start-dialog-content'),
    form: $('start-form'),
    error: $('start-error'),
    cancel: $('start-cancel'),
    confirm: $('start-confirm'),
  };
  const stop = {
    dialog: $('stop-dialog'),
    text: $('stop-dialog-text'),
    form: $('stop-form'),
    error: $('stop-error'),
    cancel: $('stop-cancel'),
    confirm: $('stop-confirm'),
  };
  const context = {
    kind: 'test',
    freeUsdt: null,
    busy: false,
    balanceRequest: 0,
  };

  const minCapital = () => getApp().strategy.minCapital;
  const capitalInput = () => start.form.querySelector('#capital-input');
  const showError = (target, message) => {
    target.textContent = message;
    target.hidden = false;
  };
  const whereLabel = (mode) => {
    const wallet = getApp().solana.walletAddress;
    return mode === 'solana_real' && wallet
      ? t('account.solanaWallet', { address: shortAddress(wallet) })
      : t(`account.${mode}`);
  };

  function updateAutoStopHints() {
    const amount = Number(capitalInput()?.value || 0);
    start.form.querySelectorAll('[data-autostop-hint]').forEach((hint) => {
      const pct = Number(hint.dataset.autostopHint);
      hint.textContent =
        pct === 0
          ? t('autostop.hintNone')
          : amount > 0
            ? t('autostop.hintSell', { amount: fmtMoney(amount * (1 - pct)) })
            : '';
    });
  }

  const capitalField = (label, value, hint, quote = 'USDT') => `
    <label class="field">
      <span class="field-label" id="capital-label">${escapeHtml(label)}</span>
      <span class="money-input">
        <input id="capital-input" type="number" inputmode="decimal" min="${minCapital()}" step="1" value="${value}" required/>
        <span>${quote}</span>
      </span>
      <span class="field-hint" id="capital-hint">${escapeHtml(hint)}</span>
    </label>`;

  const autoStopField = () => `
    <fieldset class="field">
      <legend class="field-label">${escapeHtml(t('autostop.legend'))}</legend>
      <div class="choice-grid">
        ${AUTO_STOP_OPTIONS.map(
          (value) => `
          <label class="choice">
            <input type="radio" name="autostop" value="${value}" ${value === DEFAULT_AUTO_STOP ? 'checked' : ''}/>
            <span><b>${value === 0 ? escapeHtml(t('autostop.none')) : `−${Math.round(value * 100)}%`}</b><small class="muted" data-autostop-hint="${value}"></small></span>
          </label>`,
        ).join('')}
      </div>
      <span class="field-hint">${escapeHtml(t('autostop.hint'))}</span>
    </fieldset>`;

  const consentField = (key, hidden = false) => `
    <label class="consent" id="consent-row" ${hidden ? 'hidden' : ''}>
      <input type="checkbox" id="consent-input"/>
      <span>${escapeHtml(t(key))}</span>
    </label>`;

  const setupSteps = (introKey, steps, envKey, missing) => `
    <p>${escapeHtml(t(introKey))}</p>
    <ol class="setup-steps">
      ${steps.map((key) => `<li>${t(key)}${key === steps[1] ? `<span class="code-block">${escapeHtml(t(envKey))}</span>` : ''}</li>`).join('')}
      <li>${escapeHtml(t('setup.restart'))}</li>
    </ol>
    <div class="info-box">${th('setup.missing', { items: missing.map(tm).join('; ') })}</div>`;

  async function loadBalance(mode) {
    const info = start.form.querySelector('#balance-info');
    context.freeUsdt = null;
    if (!info) return;
    if (!ACCOUNT_MODES.has(mode)) {
      info.hidden = true;
      start.confirm.disabled = false;
      return;
    }

    const requestId = ++context.balanceRequest;
    info.hidden = false;
    info.textContent = t(
      mode === 'solana_real' ? 'balance.checkingSolana' : 'balance.checkingBinance',
    );
    start.confirm.disabled = true;
    try {
      const result = await api.balance(mode);
      if (requestId !== context.balanceRequest) return;
      if (!result.success) throw new Error(tm(result.message));
      context.freeUsdt = result.freeUsdt;
      info.innerHTML = th('balance.free', {
        where: whereLabel(mode),
        amount: fmtMoney(result.freeUsdt),
        quote: result.quoteAsset,
      });
      const input = capitalInput();
      if (input && Number(input.value) > result.freeUsdt) {
        input.value = Math.floor(result.freeUsdt);
      }
      if (result.freeUsdt < minCapital()) {
        info.innerHTML += `<br>${escapeHtml(t('balance.tooLow', { amount: fmtMoney(minCapital()) }))}`;
      } else {
        start.confirm.disabled = false;
      }
    } catch (error) {
      if (requestId !== context.balanceRequest) return;
      info.innerHTML = `<span class="form-error">${escapeHtml(error.message)}</span>`;
    }
    updateAutoStopHints();
  }

  function renderSetupInstructions(app) {
    start.title.textContent = t('setup.binance.title');
    start.confirm.hidden = true;
    start.cancel.textContent = t('dialog.ok');
    start.content.innerHTML = `
      ${setupSteps(
        'setup.binance.intro',
        ['setup.binance.step1', 'setup.binance.step2'],
        'setup.binance.env',
        app.readiness.live_real.missing,
      )}
      <p>${escapeHtml(t('setup.binance.meanwhile'))}</p>`;
  }

  function renderRealForm() {
    start.title.textContent = t('real.title');
    start.confirm.textContent = t('real.confirm');
    start.confirm.className = 'btn-danger';
    start.content.innerHTML = `
      <div class="info-box" id="balance-info">${escapeHtml(t('balance.checkingBinance'))}</div>
      ${capitalField(t('real.capitalLabel'), 100, t('real.capitalHint'))}
      ${autoStopField()}
      ${consentField('real.consent')}`;
  }

  function renderTestForm(app) {
    const demoReady = app.readiness.live_testnet.available;
    start.title.textContent = t('test.title');
    start.confirm.textContent = t('test.confirm');
    start.confirm.className = 'btn-primary';
    start.content.innerHTML = `
      <p>${escapeHtml(t('test.intro'))}</p>
      ${
        demoReady
          ? `<fieldset class="field">
              <legend class="field-label">${escapeHtml(t('test.where'))}</legend>
              <div class="choice-grid">
                <label class="choice"><input type="radio" name="test-mode" value="paper" checked/><span><b>${escapeHtml(t('test.paper'))}</b><small class="muted">${escapeHtml(t('test.recommended'))}</small></span></label>
                <label class="choice"><input type="radio" name="test-mode" value="live_testnet"/><span><b>${escapeHtml(t('test.demo'))}</b><small class="muted">${escapeHtml(t('test.demoSub'))}</small></span></label>
              </div>
            </fieldset>
            <div class="info-box" id="balance-info" hidden></div>`
          : ''
      }
      ${capitalField(t('test.capitalLabel'), 1000, t('test.capitalHint'))}
      ${autoStopField()}`;
  }

  function renderSolanaForm(app) {
    const tokens = app.solana.tokens
      .map((token) => `${token.base} → ${token.symbol}`)
      .join(', ');
    const proof = app.solana.proof;
    start.title.textContent = t('solana.title');
    start.content.innerHTML = `
      <p>${escapeHtml(t('solana.intro', { tokens: tokens || t('solana.noTokens') }))}</p>
      <fieldset class="field">
        <legend class="field-label">${escapeHtml(t('solana.mode'))}</legend>
        <div class="choice-grid">
          <label class="choice"><input type="radio" name="solana-mode" value="solana_sim" checked/><span><b>${escapeHtml(t('solana.sim'))}</b><small class="muted">${escapeHtml(t('solana.simSub'))}</small></span></label>
          <label class="choice"><input type="radio" name="solana-mode" value="solana_real"/><span><b>${escapeHtml(t('solana.real'))}</b><small class="muted">${escapeHtml(t('solana.realSub'))}</small></span></label>
        </div>
      </fieldset>
      <div class="info-box" id="balance-info" hidden></div>
      <div id="solana-setup" hidden></div>
      <div id="solana-form-fields">
        ${capitalField(t('solana.capitalSim'), 1000, t('test.capitalHint'), 'USDC')}
        ${autoStopField()}
        ${consentField('solana.consent', true)}
      </div>
      ${
        proof.enabled && proof.address
          ? `<p class="field-hint">${escapeHtml(t('solana.proofNote', { cluster: proof.cluster }))}</p>`
          : ''
      }`;
    applySolanaMode(app, 'solana_sim');
  }

  function applySolanaMode(app, mode) {
    const real = mode === 'solana_real';
    const readiness = app.readiness[mode];
    const setup = start.form.querySelector('#solana-setup');
    const fields = start.form.querySelector('#solana-form-fields');
    const info = start.form.querySelector('#balance-info');
    context.balanceRequest += 1;
    context.freeUsdt = null;

    start.form.querySelector('#consent-row').hidden = !real;
    start.form.querySelector('#capital-label').textContent = t(
      real ? 'solana.capitalReal' : 'solana.capitalSim',
    );
    start.form.querySelector('#capital-hint').textContent = t(
      real ? 'solana.hintReal' : 'test.capitalHint',
    );
    start.confirm.textContent = t(real ? 'real.confirm' : 'solana.confirmSim');
    start.confirm.className = real ? 'btn-danger' : 'btn-primary';

    if (!readiness.available) {
      info.hidden = true;
      setup.hidden = false;
      fields.hidden = true;
      setup.innerHTML = real
        ? setupSteps(
            'setup.solana.intro',
            ['setup.solana.step1', 'setup.solana.step2'],
            'setup.solana.env',
            readiness.missing,
          )
        : `<div class="info-box">${readiness.missing.map((item) => escapeHtml(tm(item))).join('<br>')}</div>`;
      start.confirm.disabled = true;
      return;
    }
    setup.hidden = true;
    fields.hidden = false;
    start.confirm.disabled = false;
    if (real) {
      void loadBalance('solana_real');
    } else {
      info.hidden = true;
    }
    updateAutoStopHints();
  }

  function openStart(kind) {
    const app = getApp();
    if (!app) return;
    context.kind = kind;
    context.freeUsdt = null;
    start.error.hidden = true;
    start.confirm.disabled = false;
    start.confirm.hidden = false;
    start.cancel.textContent = t('dialog.cancel');

    if (kind === 'real' && !app.readiness.live_real.available) {
      renderSetupInstructions(app);
      start.dialog.showModal();
      return;
    }

    if (kind === 'real') {
      renderRealForm();
    } else if (kind === 'solana') {
      renderSolanaForm(app);
    } else {
      renderTestForm(app);
    }
    start.dialog.showModal();

    capitalInput().addEventListener('input', updateAutoStopHints);
    start.form
      .querySelectorAll('input[name="test-mode"]')
      .forEach((radio) =>
        radio.addEventListener('change', () => void loadBalance(radio.value)),
      );
    start.form
      .querySelectorAll('input[name="solana-mode"]')
      .forEach((radio) =>
        radio.addEventListener('change', () =>
          applySolanaMode(getApp(), radio.value),
        ),
      );
    if (kind === 'real') {
      void loadBalance('live_real');
    }
    updateAutoStopHints();
  }

  async function submitStart(event) {
    event.preventDefault();
    if (context.busy) return;
    const amount = Number(capitalInput()?.value);
    const autoStopLossPct = Number(
      start.form.querySelector('input[name="autostop"]:checked')?.value ?? 0,
    );
    const mode =
      context.kind === 'real'
        ? 'live_real'
        : context.kind === 'solana'
          ? (start.form.querySelector('input[name="solana-mode"]:checked')
              ?.value ?? 'solana_sim')
          : (start.form.querySelector('input[name="test-mode"]:checked')
              ?.value ?? 'paper');
    const quote = mode.startsWith('solana_') ? 'USDC' : 'USDT';

    if (!Number.isFinite(amount) || amount < minCapital()) {
      showError(
        start.error,
        t('form.minAmount', { amount: fmtMoney(minCapital()), quote }),
      );
      return;
    }
    if (
      ACCOUNT_MODES.has(mode) &&
      context.freeUsdt !== null &&
      amount > context.freeUsdt
    ) {
      showError(
        start.error,
        t('form.notEnough', {
          amount: fmtMoney(context.freeUsdt),
          quote,
          where: whereLabel(mode),
        }),
      );
      return;
    }
    if (
      REAL_MODES.has(mode) &&
      !start.form.querySelector('#consent-input')?.checked
    ) {
      showError(start.error, t('form.consentRequired'));
      return;
    }

    context.busy = true;
    start.error.hidden = true;
    start.confirm.disabled = true;
    const label = start.confirm.textContent;
    start.confirm.textContent = t('form.starting');
    try {
      const result = await api.start({
        mode,
        capitalUsdt: amount,
        autoStopLossPct,
      });
      start.dialog.close();
      onChanged(result.state);
      toast(t('toast.started'));
    } catch (error) {
      showError(start.error, error.message);
    } finally {
      context.busy = false;
      start.confirm.disabled = false;
      start.confirm.textContent = label;
    }
  }

  function openStop() {
    const session = getApp()?.session;
    if (!session) return;
    stop.error.hidden = true;
    const whereKey = `stop.where.${session.mode}`;
    stop.text.textContent = t('stop.text', {
      quote: session.quoteAsset ?? 'USDT',
      equity: fmtMoney(session.equity),
      profit: fmtSignedMoney(session.profit),
      where: t(whereKey) === whereKey ? '' : t(whereKey),
    });
    stop.dialog.showModal();
  }

  async function submitStop(event) {
    event.preventDefault();
    if (context.busy) return;
    context.busy = true;
    stop.confirm.disabled = true;
    stop.confirm.textContent = t('stop.selling');
    try {
      const result = await api.stop();
      stop.dialog.close();
      onChanged(result.state);
      toast(tm(result.message));
    } catch (error) {
      showError(stop.error, error.message);
    } finally {
      context.busy = false;
      stop.confirm.disabled = false;
      stop.confirm.textContent = t('stop.confirm');
    }
  }

  start.cancel.addEventListener('click', () => start.dialog.close());
  start.form.addEventListener('submit', submitStart);
  stop.cancel.addEventListener('click', () => stop.dialog.close());
  stop.form.addEventListener('submit', submitStop);

  return {
    openStart,
    openStop,
    isOpen: () => start.dialog.open || stop.dialog.open,
  };
}
