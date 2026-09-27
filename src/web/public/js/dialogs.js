// Диалоги запуска и остановки бота.

import { api } from './api.js';
import { escapeHtml, fmtMoney, fmtSignedMoney } from './format.js';

const $ = (id) => document.getElementById(id);

const AUTO_STOP_OPTIONS = [
  { value: 0, label: 'Без автозащиты' },
  { value: 0.2, label: '−20%' },
  { value: 0.3, label: '−30%' },
  { value: 0.4, label: '−40%' },
];
const DEFAULT_AUTO_STOP = 0.3;

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

  function updateAutoStopHints() {
    const amount = Number(capitalInput()?.value || 0);
    start.form.querySelectorAll('[data-autostop-hint]').forEach((hint) => {
      const pct = Number(hint.dataset.autostopHint);
      hint.textContent =
        pct === 0
          ? 'Бот не остановится сам'
          : amount > 0
            ? `Продать всё при ${fmtMoney(amount * (1 - pct))}`
            : '';
    });
  }

  const capitalField = (label, value, hint) => `
    <label class="field">
      <span class="field-label">${label}</span>
      <span class="money-input">
        <input id="capital-input" type="number" inputmode="decimal" min="${minCapital()}" step="1" value="${value}" required/>
        <span>USDT</span>
      </span>
      <span class="field-hint">${hint}</span>
    </label>`;

  const autoStopField = () => `
    <fieldset class="field">
      <legend class="field-label">Автозащита от больших потерь</legend>
      <div class="choice-grid">
        ${AUTO_STOP_OPTIONS.map(
          (option) => `
          <label class="choice">
            <input type="radio" name="autostop" value="${option.value}" ${option.value === DEFAULT_AUTO_STOP ? 'checked' : ''}/>
            <span><b>${option.label}</b><small class="muted" data-autostop-hint="${option.value}"></small></span>
          </label>`,
        ).join('')}
      </div>
      <span class="field-hint">На истории временные просадки доходили почти до половины капитала, после чего рынок восстанавливался. Слишком строгий порог может остановить бота раньше времени.</span>
    </fieldset>`;

  async function loadBalance(mode) {
    const info = start.form.querySelector('#balance-info');
    context.freeUsdt = null;
    if (!info) return;
    if (mode === 'paper') {
      info.hidden = true;
      start.confirm.disabled = false;
      return;
    }

    const requestId = ++context.balanceRequest;
    info.hidden = false;
    info.textContent = 'Проверяем баланс на Binance…';
    start.confirm.disabled = true;
    try {
      const result = await api.balance(mode);
      if (requestId !== context.balanceRequest) return;
      if (!result.success) throw new Error(result.message);
      context.freeUsdt = result.freeUsdt;
      const where = mode === 'live_real' ? 'вашем аккаунте' : 'демо-счёте';
      info.innerHTML = `Свободно на ${where} Binance: <b>${fmtMoney(result.freeUsdt)}</b>. Бот будет управлять только суммой, которую вы укажете.`;
      const input = capitalInput();
      if (input && Number(input.value) > result.freeUsdt) {
        input.value = Math.floor(result.freeUsdt);
      }
      if (result.freeUsdt < minCapital()) {
        info.innerHTML += `<br>Этого мало: минимум ${fmtMoney(minCapital())}.`;
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
    start.title.textContent = 'Как подключить реальные деньги';
    start.confirm.hidden = true;
    start.cancel.textContent = 'Понятно';
    start.content.innerHTML = `
      <p>Чтобы бот мог торговать на вашем аккаунте, нужно один раз его подключить:</p>
      <ol class="setup-steps">
        <li>На сайте Binance откройте «Управление API» и создайте ключ. Разрешите только <b>спотовую торговлю</b>. Право вывода средств <b>не включайте</b>.</li>
        <li>Откройте файл <code>.env</code> в папке бота и добавьте строки:
          <span class="code-block">BINANCE_API_KEY=ваш_ключ
BINANCE_API_SECRET=ваш_секрет
BOT_ALLOW_LIVE_REAL=true</span></li>
        <li>Перезапустите бота и обновите эту страницу.</li>
      </ol>
      <div class="info-box">Сейчас не хватает: <b>${app.readiness.live_real.missing.map(escapeHtml).join('; ')}</b></div>
      <p>Пока можно запустить тестовый режим — он работает без подключения.</p>`;
  }

  function renderRealForm() {
    start.title.textContent = 'Запуск с реальными деньгами';
    start.confirm.textContent = 'Запустить с реальными деньгами';
    start.confirm.className = 'btn-danger';
    start.content.innerHTML = `
      <div class="info-box" id="balance-info">Проверяем баланс на Binance…</div>
      ${capitalField('Сколько USDT доверить боту', 100, 'Остальные деньги на аккаунте бот не тронет.')}
      ${autoStopField()}
      <label class="consent">
        <input type="checkbox" id="consent-input"/>
        <span>Я понимаю, что бот торгует моими реальными деньгами, результат не гарантирован и возможны убытки.</span>
      </label>`;
  }

  function renderTestForm(app) {
    const demoReady = app.readiness.live_testnet.available;
    start.title.textContent = 'Запуск в тестовом режиме';
    start.confirm.textContent = 'Начать тест';
    start.confirm.className = 'btn-primary';
    start.content.innerHTML = `
      <p>Бот будет работать так же, как с настоящими деньгами, но деньги виртуальные. Цены — настоящие, с биржи Binance.</p>
      ${
        demoReady
          ? `<fieldset class="field">
              <legend class="field-label">Где тестировать</legend>
              <div class="choice-grid">
                <label class="choice"><input type="radio" name="test-mode" value="paper" checked/><span><b>Виртуальный счёт</b><small class="muted">Рекомендуется</small></span></label>
                <label class="choice"><input type="radio" name="test-mode" value="live_testnet"/><span><b>Binance Demo</b><small class="muted">Демо-счёт биржи</small></span></label>
              </div>
            </fieldset>
            <div class="info-box" id="balance-info" hidden></div>`
          : ''
      }
      ${capitalField('Сколько виртуальных денег дать боту', 1000, 'Можно любую сумму — это не настоящие деньги.')}
      ${autoStopField()}`;
  }

  function openStart(kind) {
    const app = getApp();
    if (!app) return;
    context.kind = kind;
    context.freeUsdt = null;
    start.error.hidden = true;
    start.confirm.disabled = false;
    start.confirm.hidden = false;
    start.cancel.textContent = 'Отмена';

    if (kind === 'real' && !app.readiness.live_real.available) {
      renderSetupInstructions(app);
      start.dialog.showModal();
      return;
    }

    if (kind === 'real') {
      renderRealForm();
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
        : (start.form.querySelector('input[name="test-mode"]:checked')?.value ??
          'paper');

    if (!Number.isFinite(amount) || amount < minCapital()) {
      showError(start.error, `Минимальная сумма — ${fmtMoney(minCapital())}`);
      return;
    }
    if (
      mode !== 'paper' &&
      context.freeUsdt !== null &&
      amount > context.freeUsdt
    ) {
      showError(
        start.error,
        `На Binance свободно только ${fmtMoney(context.freeUsdt)}`,
      );
      return;
    }
    if (
      mode === 'live_real' &&
      !start.form.querySelector('#consent-input')?.checked
    ) {
      showError(start.error, 'Подтвердите, что понимаете риски');
      return;
    }

    context.busy = true;
    start.error.hidden = true;
    start.confirm.disabled = true;
    const label = start.confirm.textContent;
    start.confirm.textContent = 'Запускаем… это займёт несколько секунд';
    try {
      const result = await api.start({
        mode,
        capitalUsdt: amount,
        autoStopLossPct,
      });
      start.dialog.close();
      onChanged(result.state);
      toast('Бот запущен. Первое решение уже принято — смотрите ниже.');
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
    stop.text.textContent =
      `Бот продаст все свои монеты в USDT и остановится. Сейчас у вас ${fmtMoney(session.equity)} ` +
      `(${fmtSignedMoney(session.profit)} с начала).` +
      (session.mode === 'paper'
        ? ''
        : ' Деньги останутся на вашем аккаунте Binance в USDT.');
    stop.dialog.showModal();
  }

  async function submitStop(event) {
    event.preventDefault();
    if (context.busy) return;
    context.busy = true;
    stop.confirm.disabled = true;
    stop.confirm.textContent = 'Продаём…';
    try {
      const result = await api.stop();
      stop.dialog.close();
      onChanged(result.state);
      toast(result.message);
    } catch (error) {
      showError(stop.error, error.message);
    } finally {
      context.busy = false;
      stop.confirm.disabled = false;
      stop.confirm.textContent = 'Да, остановить и продать всё';
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
