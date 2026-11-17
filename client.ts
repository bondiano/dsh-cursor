/**
 * Browser half of `@local/dsh-cursor`.
 *
 * Adds a Settings → Cursor page (account sign-in, subscription quota windows,
 * model editor) and a compact quota pill in the composer dock. Data comes from
 * the authenticated `cursor-provider.*` RPC; the page never receives an API key
 * or a Cursor CLI token.
 */

/** React slice this bundle uses; the host injects the real module at load. */
interface ReactModule {
  createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown
  useCallback<T>(callback: T, deps: readonly unknown[]): T
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  useRef<T>(initial: T): { current: T }
  useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void]
}

/** Host module loader; this bundle only requires React. */
type DshRequire = (id: 'react') => ReactModule

/** Envelope every `cursor-provider.*` RPC answers with; `ok` carries `value`. */
interface RpcResult<T> {
  ok: boolean
  value: T
  error?: { message?: string }
}

/** Authenticated RPC channel the host connection exposes. */
interface RpcChannel {
  call<T>(channel: string, method: string, payload?: object): Promise<RpcResult<T>>
}

/** Account card state reported by `cursor-provider.status`. */
interface AuthStatus {
  configured?: boolean
  source?: string
  email?: string
  expiresAt?: number
  expired?: boolean
  login?: LoginState
}

/** One sign-in attempt state; `pending` may also expose `url`. */
interface LoginState {
  state?: string
  url?: string
  error?: string
}

/** Result of `cursor-provider.status`. */
interface StatusSnapshot {
  auth?: AuthStatus
  registrationError?: string
}

/** Result of `cursor-provider.login.start`. */
interface LoginStart extends LoginState {}

/** One editable model row in the Settings catalog list. */
interface ModelDraft {
  id: string
  catalogName?: string
  description?: string
  selected?: boolean
  name?: string
  contextBudget?: number
  contextText?: string
  fast?: boolean
  fastSwitchable?: boolean
  inputModalities?: string[]
  contextTiers?: Array<{ value: string; tokens: number }>
  efforts?: Array<{ id: string; name: string }>
  defaultEffort?: string
  missing?: boolean
}

/** Result of `cursor-provider.catalog` / `settings.save`. */
interface CatalogResult {
  models: ModelDraft[]
  updatedAt?: number
}

/** One quota bucket Cursor reports for the current billing period. */
interface UsageWindow {
  key: string
  usedPercent: number
  resetsAt?: number
}

/** Quota snapshot shown by the usage card and the composer pill. */
interface UsageResult {
  supported?: boolean
  source?: string
  reason?: string
  windows?: UsageWindow[]
  plan?: { name: string; price?: string }
  resetsAt?: number
  onDemand?: { limit: number; used: number }
  note?: string
  stale?: boolean
}

/** Current model of the open conversation, read through the host service. */
interface CurrentModel {
  provider?: string
}

/** Client context slice this bundle receives; unlisted services are not touched. */
interface ClientContext {
  effect(callback: () => unknown, reason?: string): void
  get(name: 'connection'): { rpc: RpcChannel } | undefined
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
  }
  slots: {
    inject(name: string, setup: () => unknown): void
    register(descriptor: Record<string, unknown>, component: (props: never) => unknown): unknown
  }
}

/** DSH browser module registry the host injects before bundles load. */
interface Window {
  __ModuleLoader__: { load: (module: { id: string; factory: (require: DshRequire) => unknown }) => void }
}

window.__ModuleLoader__.load({
  id: '@local/dsh-cursor',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'settings.dshCursor'
    /** Shared authenticated RPC channel. */
    const CHANNEL = '/api'
    /** Endpoint prefix owned by the Host half. */
    const PREFIX = 'cursor-provider.'
    /** Visual bar thresholds, shared by the card and the pill. */
    const WARN = 80
    const CRITICAL = 95

    const en = {
      navLabel: 'Cursor',
      title: 'Cursor',
      intro: 'Use your Cursor subscription as a model provider. Cursor runs the model; DeepSeek Harness keeps tool approval, execution, and session history.',
      accountTitle: 'Account',
      signedInAs: 'Signed in as {email}',
      signedIn: 'Signed in',
      signedOut: 'Not signed in',
      signIn: 'Sign in with Cursor',
      signingIn: 'Waiting for the browser sign-in…',
      signOut: 'Sign out',
      openLink: 'Open sign-in page',
      copyLink: 'Copy link',
      copied: 'Copied',
      cancelLogin: 'Cancel',
      loginError: 'Sign-in failed: {message}',
      retry: 'Try again',
      keyExpires: 'Key expires {date}',
      keyExpired: 'The stored key has expired. Sign in again.',
      manualTitle: 'Use an existing API key',
      manualHint: 'Only for accounts that already created a Cursor API key. The key is stored in DSH credentials and never shown again.',
      manualPlaceholder: 'Cursor API key',
      saveKey: 'Save key',
      keySaved: 'API key saved.',
      usageTitle: 'Plan & usage',
      currentPlan: 'Current plan',
      planReset: 'Usage limits reset on {date} ({days} days left)',
      planResetToday: 'Usage limits reset today',
      includedIn: 'Included in {plan}',
      includedUsage: 'Included usage',
      usageNoCli: 'Cursor CLI is not signed in on this machine. Run `agent login` in a terminal, then refresh.',
      usageExpired: 'The Cursor CLI session expired. Run `agent login` again.',
      usageRejected: 'Cursor rejected the local CLI session. Run `agent login` again.',
      usageNoWindows: 'Cursor returned no usage windows for this account.',
      usageKeychain: 'Read from macOS Keychain',
      usageKeychainHint: 'macOS may ask for Keychain access. The token stays in the Host process.',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      quotaAuto: 'Cursor Models',
      quotaAutoHint: 'Includes Cursor Grok and Composer',
      quotaAutoNote: 'Additional usage beyond limits consumes Other Models quota or on-demand spend.',
      quotaApi: 'Other Models',
      quotaApiNote: 'Additional usage beyond limits consumes on-demand spend.',
      onDemandTitle: 'On-Demand',
      onDemandAmount: '{used} / {limit}',
      onDemandNote: "Requests stop at this limit. Overage from requests already running isn't billed unless the limit is raised this billing cycle.",
      usedPercent: '{percent}% used',
      stale: 'Showing the last successful reading.',
      modelsTitle: 'Models',
      modelsIntro: 'Choose which Cursor models appear in the composer. Context selects the smallest declared tier that covers the budget; leave it empty for the model default.',
      refreshCatalog: 'Refresh catalog',
      selectAll: 'Select all',
      selectNone: 'None',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      modelName: 'Display name',
      modelId: 'Model id',
      contextBudget: 'Context budget',
      contextPlaceholder: 'e.g. 500K',
      fast: 'Fast',
      imageInput: 'Images',
      efforts: 'Efforts: {efforts}',
      noModels: 'No models were returned by this account.',
      loginFirst: 'Sign in to load the Cursor model catalog.',
      missingModel: 'This saved model is no longer in the catalog. Unselect it or refresh the catalog.',
      invalidBudget: 'Context budget must be a positive number, e.g. 500K or 1M.',
      invalidName: 'Display name must be at most 120 characters.',
      modelsSaved: 'Model selection saved.',
      selectedCount: '{count} selected',
      footer: 'Cursor SDK is an agent runtime, not a raw model API. Its built-in prompt and account rules still apply; DSH tools execute only through this harness.',
      loading: 'Loading Cursor settings…',
      errorTitle: 'Cursor settings could not be loaded',
      pillCursor: 'Cursor',
      pillNoData: 'no data',
      pillTitle: 'Cursor subscription usage',
      pillOpenSettings: 'Open Cursor settings',
      pillUnavailable: 'Quota data is unavailable. Sign in with the Cursor CLI to see it.',
      unknown: 'unknown',
    }

    const ru = {
      navLabel: 'Cursor',
      title: 'Cursor',
      intro: 'Используйте подписку Cursor как провайдера моделей. Cursor запускает модель, а DeepSeek Harness сохраняет аппрувы инструментов, их исполнение и историю сессии.',
      accountTitle: 'Аккаунт',
      signedInAs: 'Вы вошли как {email}',
      signedIn: 'Вы вошли',
      signedOut: 'Вы не вошли',
      signIn: 'Войти через Cursor',
      signingIn: 'Ожидаем вход в браузере…',
      signOut: 'Выйти',
      openLink: 'Открыть страницу входа',
      copyLink: 'Скопировать ссылку',
      copied: 'Скопировано',
      cancelLogin: 'Отменить',
      loginError: 'Не удалось войти: {message}',
      retry: 'Повторить',
      keyExpires: 'Ключ действует до {date}',
      keyExpired: 'Срок сохранённого ключа истёк. Войдите снова.',
      manualTitle: 'Использовать готовый API-ключ',
      manualHint: 'Только для аккаунтов, где уже создан Cursor API key. Ключ хранится в credentials DSH и больше не показывается.',
      manualPlaceholder: 'Cursor API key',
      saveKey: 'Сохранить ключ',
      keySaved: 'API-ключ сохранён.',
      usageTitle: 'План и расход',
      currentPlan: 'Текущий план',
      planReset: 'Лимиты обнулятся {date} (осталось {days} дн.)',
      planResetToday: 'Лимиты обнулятся сегодня',
      includedIn: 'Входит в {plan}',
      includedUsage: 'Включённый расход',
      usageNoCli: 'Cursor CLI не авторизован на этой машине. Выполните `agent login` в терминале и обновите.',
      usageExpired: 'Сессия Cursor CLI истекла. Выполните `agent login` снова.',
      usageRejected: 'Cursor отклонил локальную сессию CLI. Выполните `agent login` снова.',
      usageNoWindows: 'Cursor не вернул данные о расходе для этого аккаунта.',
      usageKeychain: 'Прочитать из Keychain macOS',
      usageKeychainHint: 'macOS может запросить доступ к Keychain. Токен остаётся в Host-процессе.',
      refresh: 'Обновить',
      refreshing: 'Обновляем…',
      quotaAuto: 'Модели Cursor',
      quotaAutoHint: 'Включает Cursor Grok и Composer',
      quotaAutoNote: 'Расход сверх лимита идёт из квоты Other Models или из on-demand.',
      quotaApi: 'Other Models',
      quotaApiNote: 'Расход сверх лимита идёт из on-demand.',
      onDemandTitle: 'On-Demand',
      onDemandAmount: '{used} / {limit}',
      onDemandNote: 'Запросы останавливаются на этом лимите. Превышение по уже запущенным запросам не тарифицируется, пока лимит не поднят в этом расчётном периоде.',
      usedPercent: 'использовано {percent}%',
      stale: 'Показаны последние успешные данные.',
      modelsTitle: 'Модели',
      modelsIntro: 'Выберите модели Cursor для композера. Контекст задаёт минимальный объявленный тир, покрывающий бюджет; пустое значение — значение модели по умолчанию.',
      refreshCatalog: 'Обновить каталог',
      selectAll: 'Выбрать все',
      selectNone: 'Ничего',
      save: 'Сохранить',
      saving: 'Сохраняем…',
      cancel: 'Отмена',
      modelName: 'Отображаемое имя',
      modelId: 'ID модели',
      contextBudget: 'Бюджет контекста',
      contextPlaceholder: 'например 500K',
      fast: 'Fast',
      imageInput: 'Изображения',
      efforts: 'Усилия: {efforts}',
      noModels: 'Аккаунт не вернул ни одной модели.',
      loginFirst: 'Войдите, чтобы загрузить каталог моделей Cursor.',
      missingModel: 'Сохранённой модели больше нет в каталоге. Снимите выбор или обновите каталог.',
      invalidBudget: 'Бюджет контекста должен быть положительным числом, например 500K или 1M.',
      invalidName: 'Отображаемое имя — не длиннее 120 символов.',
      modelsSaved: 'Выбор моделей сохранён.',
      selectedCount: 'Выбрано: {count}',
      footer: 'Cursor SDK — это agent runtime, а не чистый API модели. Его встроенный промпт и правила аккаунта действуют; инструменты DSH исполняются только через этот harness.',
      loading: 'Загружаем настройки Cursor…',
      errorTitle: 'Не удалось загрузить настройки Cursor',
      pillCursor: 'Cursor',
      pillNoData: 'нет данных',
      pillTitle: 'Расход подписки Cursor',
      pillOpenSettings: 'Открыть настройки Cursor',
      pillUnavailable: 'Данные о квоте недоступны. Войдите через Cursor CLI, чтобы их видеть.',
      unknown: 'неизвестно',
    }

    const zh = {
      navLabel: 'Cursor',
      title: 'Cursor',
      intro: '将 Cursor 订阅用作模型提供商。Cursor 运行模型；DeepSeek Harness 保留工具审批、执行和会话历史。',
      accountTitle: '账户',
      signedInAs: '已登录：{email}',
      signedIn: '已登录',
      signedOut: '未登录',
      signIn: '使用 Cursor 登录',
      signingIn: '等待浏览器登录…',
      signOut: '退出',
      openLink: '打开登录页面',
      copyLink: '复制链接',
      copied: '已复制',
      cancelLogin: '取消',
      loginError: '登录失败：{message}',
      retry: '重试',
      keyExpires: '密钥到期：{date}',
      keyExpired: '保存的密钥已过期，请重新登录。',
      manualTitle: '使用现有 API 密钥',
      manualHint: '仅用于已创建 Cursor API 密钥的账户。密钥保存在 DSH credentials 中，不再显示。',
      manualPlaceholder: 'Cursor API 密钥',
      saveKey: '保存密钥',
      keySaved: 'API 密钥已保存。',
      usageTitle: '套餐与用量',
      currentPlan: '当前套餐',
      planReset: '用量限制将于 {date} 重置（剩余 {days} 天）',
      planResetToday: '用量限制今日重置',
      includedIn: '{plan} 套餐包含',
      includedUsage: '包含用量',
      usageNoCli: '本机 Cursor CLI 未登录。请在终端运行 `agent login` 后刷新。',
      usageExpired: 'Cursor CLI 会话已过期，请重新运行 `agent login`。',
      usageRejected: 'Cursor 拒绝了本地 CLI 会话，请重新运行 `agent login`。',
      usageNoWindows: 'Cursor 未返回该账户的用量数据。',
      usageKeychain: '从 macOS Keychain 读取',
      usageKeychainHint: 'macOS 可能请求 Keychain 访问权限。令牌保留在 Host 进程。',
      refresh: '刷新',
      refreshing: '刷新中…',
      quotaAuto: 'Cursor Models',
      quotaAutoHint: '包含 Cursor Grok 与 Composer',
      quotaAutoNote: '超出限制的用量将消耗 Other Models 额度或按需付费。',
      quotaApi: 'Other Models',
      quotaApiNote: '超出限制的用量将按需付费。',
      onDemandTitle: 'On-Demand',
      onDemandAmount: '{used} / {limit}',
      onDemandNote: '请求将在该限额处停止。已运行请求的超额部分在本次计费周期提高限额前不计费。',
      usedPercent: '已用 {percent}%',
      stale: '显示上次成功读取的数据。',
      modelsTitle: '模型',
      modelsIntro: '选择出现在输入框中的 Cursor 模型。上下文会选择覆盖预算的最小声明层级；留空使用模型默认值。',
      refreshCatalog: '刷新目录',
      selectAll: '全选',
      selectNone: '清空',
      save: '保存',
      saving: '保存中…',
      cancel: '取消',
      modelName: '显示名称',
      modelId: '模型 ID',
      contextBudget: '上下文预算',
      contextPlaceholder: '例如 500K',
      fast: 'Fast',
      imageInput: '图片',
      efforts: '推理级别：{efforts}',
      noModels: '账户未返回任何模型。',
      loginFirst: '登录后加载 Cursor 模型目录。',
      missingModel: '保存的模型已不在目录中。请取消选择或刷新目录。',
      invalidBudget: '上下文预算必须是正数，例如 500K 或 1M。',
      invalidName: '显示名称最多 120 个字符。',
      modelsSaved: '模型选择已保存。',
      selectedCount: '已选择 {count}',
      footer: 'Cursor SDK 是 agent 运行时，不是原始模型 API。其内置提示词和账户规则仍然生效；DSH 工具只通过本 harness 执行。',
      loading: '正在加载 Cursor 设置…',
      errorTitle: '无法加载 Cursor 设置',
      pillCursor: 'Cursor',
      pillNoData: '无数据',
      pillTitle: 'Cursor 订阅用量',
      pillOpenSettings: '打开 Cursor 设置',
      pillUnavailable: '配额数据不可用。使用 Cursor CLI 登录后可见。',
      unknown: '未知',
    }

    const CSS = `
      .dsh-cursor-page { display: flex; flex-direction: column; gap: 16px; padding-bottom: 24px; }
      .dsh-cursor-head h2 { margin: 0 0 4px; font-size: 20px; line-height: 28px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .dsh-cursor-head p { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); max-width: 760px; }
      .dsh-cursor-card { border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-secondary)); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2)); border-radius: var(--dsw-radius-card, 16px); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
      .dsh-cursor-card-head { display: flex; align-items: center; gap: 10px; }
      .dsh-cursor-card-title { font-size: 15px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .dsh-cursor-muted { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .dsh-cursor-dim { color: var(--dsw-alias-label-dimmed); }
      .dsh-cursor-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-dimmed); }
      .dsh-cursor-dot.ok { background: var(--dsw-alias-state-success-primary); }
      .dsh-cursor-dot.warn { background: var(--dsw-alias-state-warn-label); }
      .dsh-cursor-dot.err { background: var(--dsw-alias-state-error-primary); }
      .dsh-cursor-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dsh-cursor-grow { flex: 1 1 auto; min-width: 0; }
      .dsh-cursor-btn { appearance: none; border: 0.5px solid var(--dsw-alias-border-secondary); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
      .dsh-cursor-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-4); }
      .dsh-cursor-btn:disabled { opacity: 0.5; cursor: default; }
      .dsh-cursor-btn.primary { background: var(--dsw-alias-state-success-primary); border-color: transparent; color: var(--dsw-alias-label-inverse, #fff); }
      .dsh-cursor-btn.danger { color: var(--dsw-alias-state-error-primary); }
      .dsh-cursor-btn.small { padding: 3px 8px; font-size: 11px; }
      .dsh-cursor-input { box-sizing: border-box; min-width: 0; border: 0.5px solid var(--dsw-alias-border-secondary); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 5px 8px; font: inherit; font-size: 12px; line-height: 18px; }
      .dsh-cursor-input:focus { outline: 2px solid var(--dsw-alias-state-success-primary); outline-offset: -1px; }
      .dsh-cursor-input.id { font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); font-size: 11px; color: var(--dsw-alias-label-secondary); background: transparent; border-color: transparent; }
      .dsh-cursor-input.budget { width: 96px; }
      .dsh-cursor-input.name { width: 180px; }
      .dsh-cursor-error { border: 0.5px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); border-radius: 10px; padding: 10px 12px; font-size: 12px; line-height: 18px; }
      .dsh-cursor-notice { color: var(--dsw-alias-state-success-primary); font-size: 12px; line-height: 18px; }
      .dsh-cursor-link { color: var(--dsw-alias-label-link, var(--dsw-alias-state-success-primary)); text-decoration: underline; word-break: break-all; font-size: 12px; }
      .dsh-cursor-usage-list { display: flex; flex-direction: column; gap: 12px; }
      .dsh-cursor-usage-row { display: flex; flex-direction: column; gap: 4px; }
      .dsh-cursor-usage-label { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .dsh-cursor-usage-hint { color: var(--dsw-alias-label-secondary); }
      .dsh-cursor-usage-note { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
      .dsh-cursor-plan { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
      .dsh-cursor-plan-label { font-size: 11px; line-height: 16px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
      .dsh-cursor-plan-name { font-size: 15px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .dsh-cursor-section-label { font-size: 11px; line-height: 16px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
      .dsh-cursor-bar { height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-4); overflow: hidden; }
      .dsh-cursor-bar > span { display: block; height: 100%; border-radius: 3px; }
      .dsh-cursor-models { display: flex; flex-direction: column; gap: 8px; }
      .dsh-cursor-model { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 8px; align-items: start; padding: 8px 0; border-top: 0.5px solid var(--dsw-alias-border-secondary); }
      .dsh-cursor-model:first-of-type { border-top: 0; }
      .dsh-cursor-model-body { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
      .dsh-cursor-model-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dsh-cursor-model-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-dimmed); }
      .dsh-cursor-check { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dsh-cursor-model-warning { color: var(--dsw-alias-state-warn-label); font-size: 11px; }
      .dsh-cursor-pill-wrap { position: relative; display: inline-flex; flex-direction: column; align-items: flex-start; }
      .dsh-cursor-pill { appearance: none; border: 0.5px solid var(--dsw-alias-border-secondary); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 2px 9px; font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; }
      .dsh-cursor-pill:hover { background: var(--dsw-alias-bg-layer-3); }
      .dsh-cursor-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }
      .dsh-cursor-pop { margin-top: 6px; width: 260px; border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-secondary)); background: var(--dsw-alias-bg-layer-2); border-radius: 12px; padding: 10px; box-shadow: var(--dsw-elevation-prominent); display: flex; flex-direction: column; gap: 8px; }
      .dsh-cursor-pop-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .dsh-cursor-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
      details.dsh-cursor-details { border-top: 0.5px solid var(--dsw-alias-border-secondary); padding-top: 8px; }
      details.dsh-cursor-details summary { cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-secondary); }
    `

    const DATE_ONLY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
    const DAY_MS = 86_400_000

    function formatDate(ms) {
      const date = new Date(Number(ms))
      if (Number.isNaN(date.getTime())) return undefined
      try {
        return DATE_ONLY.format(date)
      } catch {
        return date.toISOString().slice(0, 10)
      }
    }

    function daysLeft(ms) {
      return Math.max(0, Math.ceil((Number(ms) - Date.now()) / DAY_MS))
    }

    /** Cursor shows whole dollars: `$0 / $2`. */
    const money = value => `$${Math.round(value * 100) / 100}`

    function barColor(usedPercent) {
      if (!Number.isFinite(usedPercent)) return 'var(--dsw-alias-label-dimmed)'
      if (usedPercent >= CRITICAL) return 'var(--dsw-alias-state-error-primary)'
      if (usedPercent >= WARN) return 'var(--dsw-alias-state-warn-label)'
      return 'var(--dsw-alias-state-success-primary)'
    }

    function parseBudget(text) {
      const value = text.trim()
      if (value === '') return { value: undefined }
      const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(value)
      if (match === null) return { error: true }
      const factor = match[2] === undefined ? 1 : match[2].toLowerCase() === 'k' ? 1_000 : 1_000_000
      const tokens = Math.round(Number(match[1]) * factor)
      return Number.isSafeInteger(tokens) && tokens > 0 ? { value: tokens } : { error: true }
    }

    const budgetText = value => {
      if (value === undefined) return ''
      if (value % 1_000_000 === 0) return `${value / 1_000_000}M`
      if (value % 1_000 === 0) return `${value / 1_000}K`
      return String(value)
    }

    function QuotaBar({ label, usedPercent }) {
      const percent = Math.round(usedPercent)
      return h(
        'div',
        {
          className: 'dsh-cursor-bar',
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': percent,
          'aria-label': label,
        },
        h('span', { style: { width: `${Math.max(0, Math.min(100, usedPercent))}%`, background: barColor(usedPercent) } }),
      )
    }

    function QuotaRow({ t, label, hint, note, usedPercent }) {
      return h(
        'div',
        { className: 'dsh-cursor-usage-row', role: 'listitem' },
        h(
          'div',
          { className: 'dsh-cursor-usage-label' },
          h('span', null, label, hint === undefined ? null : h('span', { className: 'dsh-cursor-usage-hint' }, ` · ${hint}`)),
          h('span', null, t('usedPercent', { percent: Math.round(usedPercent) })),
        ),
        h(QuotaBar, { label, usedPercent }),
        note === undefined ? null : h('div', { className: 'dsh-cursor-usage-note' }, note),
      )
    }

    function windowByKey(usage, key) {
      return Array.isArray(usage?.windows) ? usage.windows.find(window => window.key === key) : undefined
    }

    function UsageBars({ usage, t, compact = false }) {
      if (usage === undefined || usage === null) return h('div', { className: 'dsh-cursor-muted' }, t('refreshing'))
      if (usage.supported !== true || !Array.isArray(usage.windows) || usage.windows.length === 0) {
        const reason = usage.reason
        const message =
          reason === 'cli-not-connected'
            ? t('usageNoCli')
            : reason === 'cli-token-expired'
              ? t('usageExpired')
              : reason === 'cli-auth-rejected'
                ? t('usageRejected')
                : reason === 'no-windows' || reason === 'no-plan-usage'
                  ? t('usageNoWindows')
                  : t('pillUnavailable')
        return h('div', { className: 'dsh-cursor-muted', role: 'status' }, message)
      }
      const auto = windowByKey(usage, 'auto')
      const api = windowByKey(usage, 'api')
      const onDemand = usage.onDemand
      const onDemandPercent = onDemand === undefined || onDemand.limit <= 0 ? 0 : (onDemand.used / onDemand.limit) * 100
      return h(
        'div',
        { className: 'dsh-cursor-usage-list', role: 'list' },
        auto === undefined
          ? null
          : h(QuotaRow, {
              key: 'auto',
              t,
              label: t('quotaAuto'),
              hint: t('quotaAutoHint'),
              note: compact ? undefined : t('quotaAutoNote'),
              usedPercent: auto.usedPercent,
            }),
        api === undefined
          ? null
          : h(QuotaRow, {
              key: 'api',
              t,
              label: t('quotaApi'),
              note: compact ? undefined : t('quotaApiNote'),
              usedPercent: api.usedPercent,
            }),
        onDemand === undefined
          ? null
          : h(
              'div',
              { className: 'dsh-cursor-usage-row', role: 'listitem' },
              h(
                'div',
                { className: 'dsh-cursor-usage-label' },
                h('span', null, t('onDemandTitle')),
                h('span', null, t('onDemandAmount', { used: money(onDemand.used), limit: money(onDemand.limit) })),
              ),
              h(QuotaBar, { label: t('onDemandTitle'), usedPercent: onDemandPercent }),
              compact ? null : h('div', { className: 'dsh-cursor-usage-note' }, t('onDemandNote')),
            ),
        usage.stale === true ? h('div', { className: 'dsh-cursor-muted' }, t('stale')) : null,
        usage.note !== undefined && !compact ? h('div', { className: 'dsh-cursor-muted' }, usage.note) : null,
      )
    }

    async function rpcCall<T>(rpc: RpcChannel, method: string, payload: object = {}): Promise<T> {
      const result = await rpc.call<T>(CHANNEL, `${PREFIX}${method}`, payload)
      if (!result.ok) throw new Error(result.error?.message ?? 'RPC failed')
      return result.value
    }

    function CursorIcon({ size = 16, active = false }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          style: { color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)' },
        },
        h('path', {
          d: 'M3 2.5 13 8l-4.2 1.1L8 13 3 2.5Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
          fill: active ? 'currentColor' : 'none',
        }),
      )
    }

    function ModelRow({ row, index, onChange, t }) {
      const budget = parseBudget(row.contextText ?? budgetText(row.contextBudget))
      const invalidBudget = budget.error === true
      return h(
        'div',
        { className: 'dsh-cursor-model' },
        h('input', {
          type: 'checkbox',
          checked: row.selected === true,
          'aria-label': `${t('selectAll')}: ${row.name ?? row.id}`,
          onChange: event => onChange(row.id, { selected: event.target.checked }),
        }),
        h(
          'div',
          { className: 'dsh-cursor-model-body' },
          h(
            'div',
            { className: 'dsh-cursor-model-main' },
            h('input', {
              className: 'dsh-cursor-input name',
              value: row.name ?? '',
              'aria-label': t('modelName'),
              maxLength: 120,
              onChange: event => onChange(row.id, { name: event.target.value }),
            }),
            h('code', { className: 'dsh-cursor-input id' }, row.id),
            row.missing === true ? h('span', { className: 'dsh-cursor-model-warning' }, t('missingModel')) : null,
          ),
          h(
            'div',
            { className: 'dsh-cursor-model-meta' },
            h(
              'label',
              { className: 'dsh-cursor-check' },
              t('contextBudget'),
              h('input', {
                className: 'dsh-cursor-input budget',
                value: row.contextText ?? budgetText(row.contextBudget),
                placeholder: t('contextPlaceholder'),
                'aria-invalid': invalidBudget ? 'true' : 'false',
                onChange: event => {
                  const text = event.target.value
                  const parsed = parseBudget(text)
                  onChange(row.id, { contextText: text, ...(parsed.error ? {} : { contextBudget: parsed.value }) })
                },
              }),
              invalidBudget ? h('span', { className: 'dsh-cursor-model-warning' }, t('invalidBudget')) : null,
            ),
            row.fastSwitchable === true
              ? h(
                  'label',
                  { className: 'dsh-cursor-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: row.fast === true,
                    onChange: event => onChange(row.id, { fast: event.target.checked }),
                  }),
                  t('fast'),
                )
              : null,
            h(
              'label',
              { className: 'dsh-cursor-check' },
              h('input', {
                type: 'checkbox',
                checked: (row.inputModalities ?? ['text']).includes('image'),
                onChange: event => {
                  const image = event.target.checked
                  const modalities = image ? ['text', 'image'] : ['text']
                  onChange(row.id, { inputModalities: modalities })
                },
              }),
              t('imageInput'),
            ),
            Array.isArray(row.efforts) && row.efforts.length > 0
              ? h('span', null, t('efforts', { efforts: row.efforts.map(effort => effort.name).join(', ') }))
              : null,
          ),
        ),
      )
    }

    function SettingsSection(props) {
      const rpc = props.rpc
      const t = props.t
      const [snapshot, setSnapshot] = React.useState<StatusSnapshot | null>(null)
      const [catalog, setCatalog] = React.useState<CatalogResult | null>(null)
      const [usage, setUsage] = React.useState<UsageResult | null>(null)
      const [draft, setDraft] = React.useState<ModelDraft[] | null>(null)
      const [dirty, setDirtyState] = React.useState(false)
      const dirtyRef = React.useRef(false)
      const setDirty = value => {
        dirtyRef.current = value
        setDirtyState(value)
      }
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [manualKey, setManualKey] = React.useState('')
      const [manualOpen, setManualOpen] = React.useState(false)
      const [copied, setCopied] = React.useState(false)

      const call = React.useCallback(
        <T,>(method: string, payload?: object) => rpcCall<T>(rpc, method, payload),
        [rpc],
      )
      const loadStatus = React.useCallback(async () => {
        const status = await call<StatusSnapshot>('status')
        setSnapshot(status)
        return status
      }, [call])
      const loadCatalog = React.useCallback(
        async (force = false) => {
          const result = await call<CatalogResult>('catalog', force ? { refresh: true } : {})
          setCatalog(result)
          if (!dirtyRef.current) setDraft(result.models)
          return result
        },
        [call],
      )
      const loadUsage = React.useCallback(
        async options => {
          const result = await call<UsageResult>('usage', options ?? {})
          setUsage(result)
          return result
        },
        [call],
      )

      React.useEffect(() => {
        let cancelled = false
        ;(async () => {
          try {
            const status = await loadStatus()
            if (cancelled) return
            if (status.auth?.configured === true) await loadCatalog(false)
            await loadUsage({})
          } catch (loadError) {
            if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError))
          }
        })()
        return () => {
          cancelled = true
        }
      }, [loadStatus, loadCatalog, loadUsage])

      const loginState = snapshot?.auth?.login?.state ?? 'idle'
      React.useEffect(() => {
        if (loginState !== 'pending') return undefined
        const timer = setInterval(() => {
          loadStatus()
            .then(status => {
              if (status.auth?.configured === true) return loadCatalog(false)
              return undefined
            })
            .catch(() => {})
        }, 2000)
        return () => clearInterval(timer)
      }, [loginState, loadStatus, loadCatalog])

      const openUrl = url => {
        if (typeof url !== 'string' || url.length === 0) return
        // A blocked popup is recoverable: the pending row always exposes the link.
        window.open(url, '_blank', 'noopener,noreferrer')
      }

      const doLogin = async () => {
        setBusy('login')
        setError('')
        setNotice('')
        try {
          const result = await call<LoginStart>('login.start')
          if (result.url) openUrl(result.url)
          if (result.error) setError(t('loginError', { message: result.error }))
          await loadStatus()
        } catch (loginError) {
          setError(loginError instanceof Error ? loginError.message : String(loginError))
        } finally {
          setBusy('')
        }
      }

      const doCancel = async () => {
        setBusy('cancel')
        try {
          await call('login.cancel')
          await loadStatus()
        } catch (cancelError) {
          setError(cancelError instanceof Error ? cancelError.message : String(cancelError))
        } finally {
          setBusy('')
        }
      }

      const doLogout = async () => {
        setBusy('logout')
        setError('')
        try {
          await call('logout')
          setCatalog(null)
          setDraft(null)
          setUsage(null)
          setDirty(false)
          await loadStatus()
        } catch (logoutError) {
          setError(logoutError instanceof Error ? logoutError.message : String(logoutError))
        } finally {
          setBusy('')
        }
      }

      const doSaveKey = async () => {
        if (manualKey.trim() === '') return
        setBusy('key')
        setError('')
        try {
          await call('key.set', { apiKey: manualKey })
          setManualKey('')
          setManualOpen(false)
          setNotice(t('keySaved'))
          const status = await loadStatus()
          if (status.auth?.configured === true) await loadCatalog(true)
        } catch (keyError) {
          setError(keyError instanceof Error ? keyError.message : String(keyError))
        } finally {
          setBusy('')
        }
      }

      const doRefreshCatalog = async () => {
        setBusy('catalog')
        setError('')
        try {
          const result = await loadCatalog(true)
          setDraft(result.models)
          setDirty(false)
        } catch (catalogError) {
          setError(catalogError instanceof Error ? catalogError.message : String(catalogError))
        } finally {
          setBusy('')
        }
      }

      const doRefreshUsage = async keychain => {
        setBusy(keychain ? 'keychain' : 'usage')
        setError('')
        try {
          await loadUsage({ force: true, ...(keychain ? { keychain: true } : {}) })
        } catch (usageError) {
          setError(usageError instanceof Error ? usageError.message : String(usageError))
        } finally {
          setBusy('')
        }
      }

      const updateRow = (id, patch) => {
        setDraft(rows => (rows ?? []).map(row => (row.id === id ? { ...row, ...patch } : row)))
        setDirty(true)
        setNotice('')
      }

      const validationError = React.useMemo(() => {
        if (!Array.isArray(draft)) return ''
        for (const row of draft) {
          if (row.selected === true && row.missing === true) return t('missingModel')
          if (typeof row.name === 'string' && row.name.length > 120) return t('invalidName')
          if (row.contextText !== undefined && parseBudget(row.contextText).error === true) return t('invalidBudget')
          if (row.contextBudget !== undefined && !Number.isSafeInteger(row.contextBudget)) return t('invalidBudget')
        }
        return ''
      }, [draft, t])

      const doSave = async () => {
        if (!Array.isArray(draft) || validationError !== '') return
        setBusy('save')
        setError('')
        try {
          const rows = draft.filter(row => row.missing !== true).map(row => {
            const budget = parseBudget(row.contextText ?? budgetText(row.contextBudget))
            return {
              id: row.id,
              enabled: row.selected === true,
              name: row.name,
              ...(budget.value === undefined ? {} : { contextBudget: budget.value }),
              fast: row.fast === true,
              inputModalities: row.inputModalities ?? ['text'],
            }
          })
          const result = await call<CatalogResult>('settings.save', { models: rows })
          setCatalog(previous => ({ ...(previous ?? {}), models: result.models }))
          setDraft(result.models)
          setDirty(false)
          setNotice(t('modelsSaved'))
          await loadStatus()
        } catch (saveError) {
          setError(saveError instanceof Error ? saveError.message : String(saveError))
        } finally {
          setBusy('')
        }
      }

      if (snapshot === null) {
        return h('div', { className: 'dsh-cursor-page' }, h('div', { className: 'dsh-cursor-muted' }, t('loading')))
      }

      const auth: AuthStatus = snapshot.auth ?? {}
      const login: LoginState = auth.login ?? { state: 'idle' }
      const loginUrl = login.url
      const rows = draft ?? []
      const selectedCount = rows.filter(row => row.selected === true).length
      const canSave = dirty && validationError === '' && busy === '' && Array.isArray(draft)

      return h(
        'div',
        { className: 'dsh-cursor-page' },
        h('div', { className: 'dsh-cursor-head' }, h('h2', null, t('title')), h('p', null, t('intro'))),
        error !== '' ? h('div', { className: 'dsh-cursor-error', role: 'alert' }, error) : null,
        snapshot.registrationError !== undefined
          ? h('div', { className: 'dsh-cursor-error', role: 'alert' }, snapshot.registrationError)
          : null,
        notice !== '' ? h('div', { className: 'dsh-cursor-notice', role: 'status' }, notice) : null,
        h(
          'section',
          { className: 'dsh-cursor-card' },
          h(
            'div',
            { className: 'dsh-cursor-card-head' },
            h('span', { className: `dsh-cursor-dot ${auth.configured ? 'ok' : login.state === 'pending' ? 'warn' : 'dim'}` }),
            h('span', { className: 'dsh-cursor-card-title' }, t('accountTitle')),
            h('span', { className: 'dsh-cursor-grow' }),
            auth.configured
              ? h('button', { className: 'dsh-cursor-btn danger', disabled: busy !== '', onClick: doLogout }, t('signOut'))
              : h('button', { className: 'dsh-cursor-btn primary', disabled: busy !== '' || login.state === 'pending', onClick: doLogin }, t('signIn')),
          ),
          auth.configured
            ? h(
                'div',
                { className: 'dsh-cursor-muted' },
                auth.email !== undefined ? t('signedInAs', { email: auth.email }) : t('signedIn'),
                auth.expiresAt === undefined || formatDate(auth.expiresAt) === undefined
                  ? ''
                  : ` · ${t('keyExpires', { date: formatDate(auth.expiresAt) })}`,
              )
            : h('div', { className: 'dsh-cursor-muted' }, auth.expired === true ? t('keyExpired') : t('signedOut')),
          login.state === 'pending'
            ? h(
                'div',
                { className: 'dsh-cursor-row', role: 'status' },
                h('span', { className: 'dsh-cursor-muted' }, t('signingIn')),
                loginUrl !== undefined ? h('a', { className: 'dsh-cursor-link', href: loginUrl, target: '_blank', rel: 'noreferrer' }, t('openLink')) : null,
                loginUrl !== undefined
                  ? h(
                      'button',
                      {
                        className: 'dsh-cursor-btn small',
                        onClick: async () => {
                          try {
                            await navigator.clipboard.writeText(loginUrl)
                            setCopied(true)
                            setTimeout(() => setCopied(false), 1500)
                          } catch {
                            setNotice(loginUrl)
                          }
                        },
                      },
                      copied ? t('copied') : t('copyLink'),
                    )
                  : null,
                h('button', { className: 'dsh-cursor-btn small', disabled: busy !== '', onClick: doCancel }, t('cancelLogin')),
              )
            : null,
          login.state === 'error'
            ? h('div', { className: 'dsh-cursor-muted', role: 'alert' }, t('loginError', { message: login.error ?? t('unknown') }))
            : null,
          h(
            'details',
            { className: 'dsh-cursor-details' },
            h(
              'summary',
              { onClick: () => setManualOpen(open => !open) },
              t('manualTitle'),
            ),
            h(
              'div',
              { className: 'dsh-cursor-row' },
              h('input', {
                className: 'dsh-cursor-input dsh-cursor-grow',
                type: 'password',
                value: manualKey,
                placeholder: t('manualPlaceholder'),
                autoComplete: 'new-password',
                onChange: event => setManualKey(event.target.value),
              }),
              h('button', { className: 'dsh-cursor-btn', disabled: busy !== '' || manualKey.trim() === '', onClick: doSaveKey }, t('saveKey')),
            ),
            h('div', { className: 'dsh-cursor-muted' }, t('manualHint')),
          ),
        ),
        h(
          'section',
          { className: 'dsh-cursor-card' },
          h(
            'div',
            { className: 'dsh-cursor-card-head' },
            h('span', { className: 'dsh-cursor-card-title' }, t('usageTitle')),
            h('span', { className: 'dsh-cursor-grow' }),
            h('button', { className: 'dsh-cursor-btn', disabled: busy !== '', onClick: () => doRefreshUsage(false) }, busy === 'usage' ? t('refreshing') : t('refresh')),
          ),
          usage?.plan === undefined
            ? null
            : h(
                'div',
                { className: 'dsh-cursor-plan' },
                h('span', { className: 'dsh-cursor-plan-label' }, t('currentPlan')),
                h(
                  'span',
                  null,
                  h('span', { className: 'dsh-cursor-plan-name' }, usage.plan.name),
                  usage.plan.price === undefined ? null : h('span', { className: 'dsh-cursor-muted' }, ` ${usage.plan.price}`),
                ),
              ),
          usage?.resetsAt === undefined || formatDate(usage.resetsAt) === undefined
            ? null
            : h(
                'div',
                { className: 'dsh-cursor-muted' },
                daysLeft(usage.resetsAt) === 0
                  ? t('planResetToday')
                  : t('planReset', { date: formatDate(usage.resetsAt), days: daysLeft(usage.resetsAt) }),
              ),
          usage?.supported === true
            ? h(
                'div',
                { className: 'dsh-cursor-section-label' },
                usage.plan === undefined ? t('includedUsage') : t('includedIn', { plan: usage.plan.name }),
              )
            : null,
          h(UsageBars, { usage, t }),
          usage !== null && usage.supported !== true
            ? h(
                'div',
                { className: 'dsh-cursor-row' },
                h('button', { className: 'dsh-cursor-btn', disabled: busy !== '', onClick: () => doRefreshUsage(true) }, t('usageKeychain')),
                h('span', { className: 'dsh-cursor-muted' }, t('usageKeychainHint')),
              )
            : null,
        ),
        h(
          'section',
          { className: 'dsh-cursor-card' },
          h(
            'div',
            { className: 'dsh-cursor-card-head' },
            h('span', { className: 'dsh-cursor-card-title' }, t('modelsTitle')),
            h('span', { className: 'dsh-cursor-grow' }),
            h('span', { className: 'dsh-cursor-muted' }, t('selectedCount', { count: selectedCount })),
            h('button', { className: 'dsh-cursor-btn', disabled: busy !== '' || !auth.configured, onClick: doRefreshCatalog }, busy === 'catalog' ? t('refreshing') : t('refreshCatalog')),
          ),
          h('div', { className: 'dsh-cursor-muted' }, t('modelsIntro')),
          auth.configured !== true
            ? h('div', { className: 'dsh-cursor-muted' }, t('loginFirst'))
            : catalog === null
              ? h('div', { className: 'dsh-cursor-muted' }, t('loading'))
              : rows.length === 0
                ? h('div', { className: 'dsh-cursor-muted' }, t('noModels'))
                : h(
                    'div',
                    { className: 'dsh-cursor-models' },
                    h(
                      'div',
                      { className: 'dsh-cursor-row' },
                      h('button', { className: 'dsh-cursor-btn small', onClick: () => { setDraft(items => (items ?? []).map(row => ({ ...row, selected: true }))); setDirty(true) } }, t('selectAll')),
                      h('button', { className: 'dsh-cursor-btn small', onClick: () => { setDraft(items => (items ?? []).map(row => ({ ...row, selected: false }))); setDirty(true) } }, t('selectNone')),
                    ),
                    rows.map((row, index) => h(ModelRow, { key: row.id, row, index, t, onChange: updateRow })),
                    validationError !== '' ? h('div', { className: 'dsh-cursor-error', role: 'alert' }, validationError) : null,
                    h(
                      'div',
                      { className: 'dsh-cursor-row' },
                      h('button', { className: 'dsh-cursor-btn primary', disabled: !canSave, onClick: doSave }, busy === 'save' ? t('saving') : t('save')),
                      h(
                        'button',
                        {
                          className: 'dsh-cursor-btn',
                          disabled: busy !== '' || !dirty,
                          onClick: () => {
                            setDraft(catalog?.models ?? [])
                            setDirty(false)
                            setNotice('')
                          },
                        },
                        t('cancel'),
                      ),
                    ),
                  ),
        ),
        h('div', { className: 'dsh-cursor-muted' }, t('footer')),
      )
    }

    function createCurrentModelReader(ctx, sessionId) {
      return async () => {
        const directories = ctx.get('modelDirectories')
        if (directories === undefined || typeof directories.directoryFor !== 'function') return undefined
        try {
          const { current } = await directories.directoryFor(sessionId).load()
          return current ?? undefined
        } catch {
          return undefined
        }
      }
    }

    function ProviderPill(props) {
      const rpc = props.rpc
      const t = props.t
      const currentModel = props.currentModel
      const [current, setCurrent] = React.useState<CurrentModel | undefined>(undefined)
      const [usage, setUsage] = React.useState<UsageResult | null>(null)
      const [expanded, setExpanded] = React.useState(false)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let cancelled = false
        const read = async () => {
          try {
            const value = await currentModel()
            if (!cancelled) setCurrent(value)
          } catch {
            if (!cancelled) setCurrent(undefined)
          }
        }
        void read()
        return () => {
          cancelled = true
        }
      }, [currentModel])

      const isCursor = current?.provider === 'cursor'
      React.useEffect(() => {
        if (!isCursor) {
          setUsage(null)
          return undefined
        }
        let cancelled = false
        const load = async () => {
          try {
            const value = await rpcCall<UsageResult>(rpc, 'usage', {})
            if (!cancelled) setUsage(value)
          } catch {
            if (!cancelled) setUsage({ supported: false, windows: [], reason: 'unavailable' })
          }
        }
        void load()
        const timer = setInterval(load, 60_000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [isCursor, rpc])

      if (!isCursor) return null
      const windows = Array.isArray(usage?.windows) ? usage.windows : []
      const total = windows.find(window => window.key === 'total') ?? windows[0]
      const label = usage?.supported === true && total !== undefined
        ? `${t('pillCursor')} · ${Math.round(total.usedPercent)}%`
        : `${t('pillCursor')} · ${t('pillNoData')}`

      const refresh = async () => {
        setBusy(true)
        try {
          setUsage(await rpcCall<UsageResult>(rpc, 'usage', { force: true }))
        } catch {
          setUsage({ supported: false, windows: [], reason: 'unavailable' })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'dsh-cursor-pill-wrap' },
        h(
          'button',
          {
            className: 'dsh-cursor-pill',
            type: 'button',
            title: t('pillTitle'),
            'aria-expanded': expanded,
            onClick: () => setExpanded(value => !value),
          },
          h('span', { className: 'dsh-cursor-pill-dot', style: { background: usage?.supported === true && total !== undefined ? barColor(total.usedPercent) : 'var(--dsw-alias-label-dimmed)' } }),
          label,
        ),
        expanded
          ? h(
              'div',
              { className: 'dsh-cursor-pop', role: 'dialog', 'aria-label': t('pillTitle') },
              h('div', { className: 'dsh-cursor-pop-title' }, t('pillTitle')),
              h(UsageBars, { usage, t, compact: true }),
              h(
                'div',
                { className: 'dsh-cursor-row' },
                h('button', { className: 'dsh-cursor-btn small', disabled: busy, onClick: refresh }, busy ? t('refreshing') : t('refresh')),
              ),
            )
          : null,
      )
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx: ClientContext) {
        ctx.effect(() => ctx.locale.register(NS, { en, ru, zh }), 'dsh-cursor: dictionaries')
        ctx.effect(() => {
          for (const previous of document.querySelectorAll('style[data-dsh-plugin="dsh-cursor"]')) previous.remove()
          const style = document.createElement('style')
          style.dataset.dshPlugin = 'dsh-cursor'
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        }, 'dsh-cursor: styles')

        const connection = ctx.get('connection')
        if (connection?.rpc === undefined) return
        const t = ctx.locale.bind(NS)
        const injected = () => ({ rpc: connection?.rpc, t })

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'cursor',
              order: 95,
              label: () => t('navLabel'),
              locale: NS,
              inject: injected,
            },
            SettingsSection,
          ),
        )
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register(
            {
              name: 'settings.section.icon',
              id: 'cursor',
              order: 95,
            },
            CursorIcon,
          ),
        )
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'cursor-usage',
              order: 11,
              locale: NS,
              inject: sessionId => ({
                rpc: connection?.rpc,
                t,
                currentModel: createCurrentModelReader(ctx, sessionId),
              }),
            },
            ProviderPill,
          ),
        )
      },
    }
  },
})
