;(() => {
/**
 * 共享的「模型选择」模块（浏览器半）——CodeBuddy / Cursor / Antigravity 三个 ACP
 * 提供商共用。
 *
 * 用法（各插件 build 会把本文件拼在 `src/client.js` 前面，因此这里**只能**定义
 * 工厂函数，不得引用宿主作用域的任何符号）：
 *
 * ```js
 * const { Modal, Button } = require('@deepseek-ai/dsh-client-ui-primitives')
 * const MS = createModelSelection({ React, h, t, Modal, Button })
 * // 供应商级
 * h(MS.ModelSelectionBlock, {
 *   adapter: MS.providerAdapter({ client, field: 'visibleModels' }),
 *   onStatus: (next) => setStatus(next),
 * })
 * // 账号级（子集：候选只来自供应商已启用的模型）
 * h(MS.ModelSelectionBlock, {
 *   adapter: MS.accountAdapter({ client, accountId, providerVisible }),
 * })
 * ```
 *
 * 交互分两层：
 *   · 卡片行内直接操作：每行右侧带一键移除按钮（保留至少 1 个模型），卡片底部支持
 *     本地零网络展开/添加未选模型，日常删改无需先点「获取可用模型」弹窗；
 *   · 弹窗批量选择与远程同步：「获取可用模型」用于向端点同步目录并批量搜索勾选。
 *
 * 约束：插件测试沙箱是手写 mini-React，**没有 Set / Map / useMemo**，故一律用数组。
 */
function createModelSelection(deps) {
  const MODEL_SELECTION_VERSION = 1
  const { React, h, t, Modal, Button } = deps

  /** 区块与弹窗的样式，由宿主插件拼进自己的样式表。 */
  const CSS = `
.dsh-modelselection { display: flex; flex-direction: column; gap: 8px; padding: 0; min-width: 0; }
.dsh-modelselection-compact { gap: 6px; }
.dsh-modelselection-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 0 2px; min-height: 26px; }
.dsh-modelselection-title { font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dsh-modelselection-compact .dsh-modelselection-title { font-size: 13px; }
.dsh-modelselection-desc { margin: -2px 2px 2px; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary, currentColor); }
.dsh-modelselection-compact .dsh-modelselection-desc { font-size: 11.5px; line-height: 16px; margin: -2px 2px 0; }
.dsh-modelselection-meta { font-size: 11px; line-height: 18px; padding: 2px 9px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform, color-mix(in srgb, currentColor 6%, transparent)); color: var(--dsw-alias-label-tertiary, currentColor); font-variant-numeric: tabular-nums; }
.dsh-modelselection-meta-custom { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 12%, transparent) !important; color: var(--dsw-alias-state-business-primary, #4176e6) !important; font-weight: 500; }
.dsh-modelselection-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }
.dsh-modelselection-rows { display: flex; flex-direction: column; padding: 2px 6px; border: 0.5px solid var(--dsw-alias-settings-card-stroke, color-mix(in srgb, currentColor 14%, transparent)); border-radius: var(--dsw-radius-lg, 16px); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, transparent)); max-height: 296px; overflow-y: auto; }
.dsh-modelselection-compact .dsh-modelselection-rows { max-height: 220px; border-radius: 12px; }
.dsh-modelselection-row { display: flex; align-items: center; gap: 10px; font-size: 13px; min-height: 36px; padding: 3px 6px 3px 10px; min-width: 0; }
.dsh-modelselection-row + .dsh-modelselection-row, .dsh-modelselection-footer { border-top: 0.5px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 9%, transparent)); }
.dsh-modelselection-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: var(--dsw-alias-label-primary, inherit); white-space: nowrap; flex-shrink: 0; }
.dsh-modelselection-name { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-tertiary, currentColor); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.dsh-modelselection-remove { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; flex: 0 0 26px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary, currentColor); opacity: .62; cursor: pointer; transition: background 120ms ease, color 120ms ease, opacity 120ms ease; }
@media (hover: hover) { .dsh-modelselection-remove:hover:not(:disabled) { opacity: 1; color: var(--dsw-alias-state-error-primary, #d9534f); background: var(--dsw-alias-interactive-bg-hover-danger, color-mix(in srgb, #d9534f 10%, transparent)); } }
.dsh-modelselection-remove:focus-visible { outline: none; opacity: 1; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6)); }
.dsh-modelselection-remove:disabled { opacity: .2; cursor: default; }
.dsh-modelselection-footer { display: flex; flex-direction: column; padding: 2px 0; }
.dsh-modelselection-add-trigger { box-sizing: border-box; display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; padding: 4px 10px; border: 0; border-radius: 10px; background: transparent; color: var(--dsw-alias-state-business-primary, #4176e6); font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; text-align: left; transition: background 120ms ease; }
@media (hover: hover) { .dsh-modelselection-add-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 5%, transparent)); } }
.dsh-modelselection-add-trigger:disabled { opacity: .45; cursor: default; }
.dsh-modelselection-add-drawer { display: flex; flex-direction: column; margin: 2px 4px 4px; padding: 4px; border-radius: 10px; background: var(--dsw-alias-bg-module-platform, color-mix(in srgb, currentColor 4%, transparent)); }
.dsh-modelselection-add-option { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 2px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 12.5px; cursor: pointer; text-align: left; }
@media (hover: hover) { .dsh-modelselection-add-option:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 6%, transparent)); } }
.dsh-modelselection-add-option:disabled { opacity: .45; cursor: default; }
.dsh-modelselection-global-off { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-top: 4px; border-top: 0.5px dashed var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 10%, transparent)); font-size: 11px; color: var(--dsw-alias-label-tertiary, currentColor); }
.dsh-modelselection-global-off-chip { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 6px; background: color-mix(in srgb, currentColor 5%, transparent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; opacity: .72; }
.dsh-modelselection-empty { font-size: 12px; color: var(--dsw-alias-label-tertiary, currentColor); margin: 0; padding: 12px 14px; border-radius: var(--dsw-radius-lg, 14px); border: 0.5px dashed var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 18%, transparent)); }
.dsh-modelselection-error { color: var(--dsw-alias-state-error-primary, #d9534f); font-size: 12px; margin: 0; padding: 0 2px; }
.dsh-modelselection-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.dsh-modelselection-search { flex: 1; font: inherit; font-size: 13px; height: 34px; box-sizing: border-box; padding: 0 10px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l4, color-mix(in srgb, currentColor 20%, transparent)); background: var(--dsw-alias-bg-layer-3, transparent); color: inherit; outline: none; }
.dsh-modelselection-search:focus-visible { border-color: var(--dsw-alias-state-business-primary, #4176e6); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 18%, transparent); }
.dsh-modelselection-list { list-style: none; margin: 0; padding: 2px 0; max-height: 46vh; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.dsh-modelselection-item { display: flex; align-items: center; border-radius: 8px; font-size: 13px; }
@media (hover: hover) { .dsh-modelselection-item:hover { background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 5%, transparent)); } }
.dsh-modelselection-item-label { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; cursor: pointer; min-width: 0; box-sizing: border-box; }
.dsh-modelselection-item code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; white-space: nowrap; flex-shrink: 0; }
.dsh-modelselection-item .dsh-modelselection-name { margin-left: auto; }
.dsh-modelselection-nomatch { font-size: 13px; color: var(--dsw-alias-label-tertiary, currentColor); margin: 12px 0; }
`

  const INLINE_ADD_LIMIT = 8

  const closeIcon = () => h('svg', {
    viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true',
  }, h('path', {
    d: 'M6 6l12 12M18 6L6 18',
    stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round',
  }))

  const plusIcon = () => h('svg', {
    viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true', style: { flexShrink: 0 },
  }, h('path', {
    d: 'M12 5v14M5 12h14',
    stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round',
  }))

  // ── 选择代数（纯函数：三个插件共用同一份行为，测试只测这一份）─────────────

  /** 候选列表：数据源没给就是空。 */
  function candidatesOf(adapter, status) {
    if (!adapter || typeof adapter.candidates !== 'function') return []
    const list = adapter.candidates(status)
    return Array.isArray(list) ? list : []
  }

  /** 基线勾选集合（数据源默认值，通常是「已启用」的 id）。 */
  function checkedOf(adapter, status, candidates) {
    if (adapter && typeof adapter.checked === 'function') {
      const list = adapter.checked(status)
      return Array.isArray(list) ? list : []
    }
    return candidates.filter((candidate) => candidate.enabled !== false).map((candidate) => candidate.id)
  }

  /** 当前是否勾选：基线 XOR 本次翻动。 */
  function isPicked(id, checked, flipped) {
    return (checked.indexOf(id) >= 0) !== (flipped.indexOf(id) >= 0)
  }

  /** 当前勾选的全部 id。 */
  function pickedIdsOf(candidates, checked, flipped) {
    return candidates.filter((candidate) => isPicked(candidate.id, checked, flipped)).map((candidate) => candidate.id)
  }

  /** 搜索匹配 id 或显示名（大小写无关的子串）。 */
  function matchesQuery(candidate, normalizedQuery) {
    if (normalizedQuery.length === 0) return true
    if (String(candidate.id).toLowerCase().indexOf(normalizedQuery) >= 0) return true
    return typeof candidate.name === 'string' && candidate.name.toLowerCase().indexOf(normalizedQuery) >= 0
  }

  /** 翻转一个 id。 */
  function toggleId(flipped, id) {
    return flipped.indexOf(id) >= 0 ? flipped.filter((item) => item !== id) : flipped.concat([id])
  }

  /** 全选 / 取消全选：只作用于可见项。 */
  function toggleVisible(flipped, visible, checked) {
    const allVisiblePicked = visible.length > 0 && visible.every((candidate) => isPicked(candidate.id, checked, flipped))
    const target = !allVisiblePicked
    let next = flipped.slice()
    for (const candidate of visible) {
      const has = next.indexOf(candidate.id) >= 0
      if ((checked.indexOf(candidate.id) >= 0) === target) {
        if (has) next = next.filter((item) => item !== candidate.id)
      } else if (!has) {
        next = next.concat([candidate.id])
      }
    }
    return next
  }

  /** 账号级子集：候选只保留供应商已启用的 id（供应商空清单 = 全部启用）。 */
  function subsetOf(candidates, providerVisible) {
    if (!Array.isArray(providerVisible) || providerVisible.length === 0) {
      return candidates.filter((candidate) => candidate.enabled !== false)
    }
    return candidates.filter((candidate) => providerVisible.indexOf(candidate.id) >= 0)
  }

  // ── 数据源适配 ────────────────────────────────────────────────────────

  /**
   * 供应商级：读写插件自身的一个可见性字段。
   * @param options.client - 插件 remote 客户端（status / warmup / configure）。
   * @param options.field - 写入的配置字段（`visibleModels` 或 `enabledModels`）。
   * @param options.resetPatch - 「恢复默认」写入的补丁，缺省为 `{ [field]: [] }`。
   * @param options.title - 区块标题，缺省「模型」。
   * @param options.subtitle - 标题旁的补充说明。
   */
  function providerAdapter(options) {
    const client = options.client
    const field = options.field
    const candidates = (status) => (status && Array.isArray(status.availableModels) ? status.availableModels : [])
    return {
      title: options.title || t('Exposed models', '对外可用模型'),
      subtitle: options.subtitle,
      description: options.description !== undefined
        ? options.description
        : t(
          'Controls which models appear in the composer picker; turning a model off hides it across all accounts.',
          '控制对话模型菜单中展示的模型；在此关闭后全局隐藏，所有账号均不再对外提供。',
        ),
      candidates,
      checked: (status) => candidates(status).filter((model) => model.enabled !== false).map((model) => model.id),
      load: () => client.status(),
      fetch: () => client.warmup(),
      apply: (ids) => client.configure({ [field]: ids }),
      reset: () => client.configure(options.resetPatch || { [field]: [] }),
    }
  }

  /**
   * 账号级：候选来自「该账号真实支持的模型 ∩ 全局已启用模型」，写回该账号自己的清单。
   * 空数组表示「跟随全局（不额外限制）」。
   */
  function accountAdapter(options) {
    const client = options.client
    const accountId = options.accountId
    const field = options.accountField || 'visibleModels'
    const accountsOf = (status) => (status && Array.isArray(status.accounts) ? status.accounts : [])
    const rawAccountBase = (status) => {
      const account = accountsOf(status).filter((entry) => entry && entry.id === accountId)[0]
      return account && Array.isArray(account.availableModels) && account.availableModels.length > 0
        ? account.availableModels
        : (status && Array.isArray(status.availableModels) ? status.availableModels : [])
    }
    const candidates = (status) => subsetOf(
      rawAccountBase(status),
      status && Array.isArray(status.visibleModels) ? status.visibleModels : [],
    )
    const globallyHidden = (status) => {
      const activeIds = candidates(status).map((c) => c.id)
      return rawAccountBase(status).filter((item) => activeIds.indexOf(item.id) < 0)
    }
    const submit = (status, ids) => {
      if (typeof options.submit === 'function') return options.submit(status, ids)
      if (typeof options.writeAccounts !== 'function') return Promise.resolve(status)
      return client.configure({ accounts: options.writeAccounts(status, accountId, ids) })
    }
    return {
      title: options.title || t('Routable models', '账号调度模型'),
      description: options.description !== undefined
        ? options.description
        : t(
          'Limits which models the scheduler routes to this account; unchecked models route to other accounts.',
          '限定调度器允许分派给该账号的模型；未勾选的模型自动交由池内其他账号承接。',
        ),
      candidates,
      globallyHidden,
      checked: (status) => {
        const account = accountsOf(status).filter((entry) => entry && entry.id === accountId)[0]
        const own = account && Array.isArray(account[field]) ? account[field] : []
        const offeredIds = candidates(status).map((candidate) => candidate.id)
        if (own.length === 0) return offeredIds
        return own.filter((id) => offeredIds.indexOf(id) >= 0)
      },
      load: () => client.status(),
      fetch: () => (typeof options.fetch === 'function' ? options.fetch() : client.warmup()),
      apply: (ids, status) => submit(status, ids),
      reset: (status) => submit(status, []),
    }
  }

  // ── 区块 ──────────────────────────────────────────────────────────────

  /**
   * 模型选择区块：
   *   1. 已启用模型直接在卡片内每行展示，右侧带一键移除按钮（无需弹窗）；
   *   2. 有未启用模型时，卡片底部提供本地零延迟「+ 添加模型」（候选较少时原地展开即点即加，候选较多时秒开搜索弹窗）；
   *   3. 顶部「获取可用模型」用于向服务端同步最新目录并打开批量选择弹窗。
   * @param props.adapter - 见 {@link providerAdapter} / {@link accountAdapter}。
   * @param props.disabled - 额外禁用（父级写入中、只读部署等）。
   * @param props.compact - 紧凑版：账号编辑器内使用。
   * @param props.onStatus - 可选回调，状态更新后同步通知父组件。
   */
  function ModelSelectionBlock(props) {
    const adapter = props.adapter
    const adapterRef = React.useRef(adapter)
    adapterRef.current = adapter
    const seqRef = React.useRef(0)
    const [status, setStatus] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [failure, setFailure] = React.useState(null)
    const [open, setOpen] = React.useState(false)
    const [addingInline, setAddingInline] = React.useState(false)
    const [query, setQuery] = React.useState('')
    const [flipped, setFlipped] = React.useState([])
    const externalDisabled = props.disabled === true
    const isCompact = props.compact === true
    const isDraftControlled = Array.isArray(props.draftIds) && typeof props.onDraftChange === 'function'
    // On the Models settings page (`settings.models.provider-card`), stay
    // collapsed like DeepSeek / AxonHub until the user clicks Edit (`open === true`).
    const collapsedOnModelsPage = props.provider !== undefined && props.open === false

    const publishStatus = (next) => {
      setStatus(next)
      setFailure(next && next.error ? String(next.error) : null)
      if (typeof props.onStatus === 'function' && next !== null && typeof next === 'object') {
        props.onStatus(next)
      }
    }

    const run = async (kind) => {
      const target = adapterRef.current
      const seq = ++seqRef.current
      setBusy(true)
      try {
        const next = kind === 'fetch' ? await target.fetch() : await target.load()
        if (seq === seqRef.current) publishStatus(next)
        return next || null
      } catch (error) {
        if (seq === seqRef.current) setFailure(error instanceof Error ? error.message : String(error))
        return null
      } finally {
        if (seq === seqRef.current) setBusy(false)
      }
    }

    React.useEffect(() => {
      if (!collapsedOnModelsPage) void run('load')
    }, [collapsedOnModelsPage])

    const candidates = candidatesOf(adapter, status)
    const candidateIds = candidates.map((c) => c.id)
    const globallyHidden = adapter && typeof adapter.globallyHidden === 'function' ? adapter.globallyHidden(status) : []
    const checked = isDraftControlled
      ? (props.draftIds.length === 0
        ? candidateIds
        : candidateIds.filter((id) => props.draftIds.indexOf(id) >= 0))
      : checkedOf(adapter, status, candidates)
    const picked = pickedIdsOf(candidates, checked, flipped)
    const unpicked = candidates.filter((candidate) => checked.indexOf(candidate.id) < 0)
    const customized = isDraftControlled
      ? (props.draftIds.length > 0 && checked.length < candidates.length)
      : ((adapter && typeof adapter.checked === 'function')
        ? checked.length !== candidates.length
        : candidates.some((model) => model.enabled === false))

    const close = () => { setOpen(false); setQuery(''); setFlipped([]) }

    const applyIds = async (nextIds) => {
      if (nextIds.length === 0) return null
      const target = adapterRef.current
      const seq = ++seqRef.current
      setBusy(true)
      try {
        const next = await target.apply(nextIds, status)
        if (seq === seqRef.current) publishStatus(next)
        return next
      } catch (error) {
        if (seq === seqRef.current) setFailure(error instanceof Error ? error.message : String(error))
        return null
      } finally {
        if (seq === seqRef.current) setBusy(false)
      }
    }

    const resetModels = async () => {
      if (isDraftControlled) {
        setAddingInline(false)
        props.onDraftChange([])
        return null
      }
      const target = adapterRef.current
      const seq = ++seqRef.current
      setBusy(true)
      try {
        const next = await target.reset(status)
        if (seq === seqRef.current) {
          setAddingInline(false)
          publishStatus(next)
        }
        return next
      } catch (error) {
        if (seq === seqRef.current) setFailure(error instanceof Error ? error.message : String(error))
        return null
      } finally {
        if (seq === seqRef.current) setBusy(false)
      }
    }

    /** 行内直接移除单个模型（保留至少 1 个启用项）。 */
    const removeInline = async (id) => {
      const nextIds = checked.filter((item) => item !== id)
      if (nextIds.length === 0) return
      if (isDraftControlled) {
        props.onDraftChange(nextIds)
        return
      }
      await applyIds(nextIds)
    }

    /** 行内直接加回单个模型，按原候选顺序排列。 */
    const addInline = async (id) => {
      if (checked.indexOf(id) >= 0) return
      const nextSet = checked.concat([id])
      const ordered = candidates.filter((candidate) => nextSet.indexOf(candidate.id) >= 0).map((candidate) => candidate.id)
      if (isDraftControlled) {
        props.onDraftChange(ordered.length >= candidates.length ? [] : ordered)
        if (ordered.length >= candidates.length) setAddingInline(false)
        return
      }
      const next = await applyIds(ordered)
      if (next !== null && ordered.length >= candidates.length) {
        setAddingInline(false)
      }
    }

    /** 本地零网络打开选择弹窗（用于候选较多时的批量增删）。 */
    const openLocalPicker = () => {
      setQuery('')
      setFlipped([])
      setOpen(true)
    }

    /** 同步远程端点目录并打开选择模型弹窗（供应商级与账号级统一交互）。 */
    const fetchModels = async () => {
      if (candidates.length > 0) {
        setQuery('')
        setFlipped([])
        setOpen(true)
        void run('fetch')
        return
      }
      const next = await run('fetch')
      if (next === null) return
      const list = candidatesOf(adapter, next)
      if (list.length === 0) {
        setFailure(t('This provider reported no models; try again later.', '该提供商没有上报任何模型，请稍后再试'))
        return
      }
      setQuery('')
      setFlipped([])
      setOpen(true)
    }

    const adopt = async () => {
      if (picked.length === 0) return
      if (isDraftControlled) {
        const ordered = candidateIds.filter((cid) => picked.indexOf(cid) >= 0)
        props.onDraftChange(ordered.length >= candidates.length ? [] : ordered)
        setAddingInline(false)
        close()
        return
      }
      if (await applyIds(picked) !== null) close()
    }

    const normalized = query.trim().toLowerCase()
    const visible = candidates.filter((candidate) => matchesQuery(candidate, normalized))
    const allVisiblePicked = visible.length > 0 && visible.every((candidate) => isPicked(candidate.id, checked, flipped))

    const summary = busy && !open
      ? t('Updating…', '正在更新…')
      : candidates.length === 0
        ? t('No catalog fetched yet', '尚未获取模型目录')
        : customized
          ? t(`${checked.length} of ${candidates.length} models selected`, `已选 ${checked.length} / ${candidates.length} 个模型`)
          : t(`All ${candidates.length} models`, `全部 ${candidates.length} 个模型`)

    const canRemoveRow = checked.length > 1 && !busy && !externalDisabled
    if (collapsedOnModelsPage) return null

    return h('section', {
      className: isCompact ? 'dsh-modelselection dsh-modelselection-compact' : 'dsh-modelselection',
      'aria-label': adapter.title || t('Models', '模型'),
    },
      h('div', { className: 'dsh-modelselection-head' },
        h('span', { className: 'dsh-modelselection-title' }, adapter.title || t('Models', '模型')),
        h('span', {
          className: customized ? 'dsh-modelselection-meta dsh-modelselection-meta-custom' : 'dsh-modelselection-meta',
        }, summary),
        adapter.subtitle === undefined ? null : h('span', { className: 'dsh-modelselection-name' }, adapter.subtitle),
        h('span', { className: 'dsh-modelselection-actions' },
          customized
            ? h(Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: busy || externalDisabled,
              onClick: () => void resetModels(),
            }, t('Restore defaults', '恢复默认'))
            : null,
          h(Button, {
            variant: 'outline',
            size: 'sm',
            disabled: busy || externalDisabled,
            onClick: () => void fetchModels(),
          }, t('Fetch models', '获取可用模型')))),
      adapter.description ? h('p', { className: 'dsh-modelselection-desc' }, adapter.description) : null,
      candidates.length === 0
        ? h('p', { className: 'dsh-modelselection-empty' }, t('Use “Fetch models” to read this provider’s catalog.', '点击「获取可用模型」读取该提供商的实时模型目录'))
        : h('div', { className: 'dsh-modelselection-rows' },
          ...checked.map((id) => {
            const model = candidates.filter((candidate) => candidate.id === id)[0]
            return h('div', { key: id, className: 'dsh-modelselection-row' },
              h('code', { className: 'dsh-modelselection-id' }, id),
              h('span', { className: 'dsh-modelselection-name' }, model && model.name && model.name !== id ? model.name : ''),
              h('button', {
                type: 'button',
                className: 'dsh-modelselection-remove',
                'aria-label': t(`Remove ${id}`, `移除 ${id}`),
                title: checked.length <= 1
                  ? t('Keep at least one model enabled', '请至少保留一个启用的模型')
                  : t(`Remove ${id}`, `移除 ${id}`),
                disabled: !canRemoveRow,
                onClick: () => void removeInline(id),
              }, closeIcon()))
          }),
          unpicked.length > 0
            ? h('div', { className: 'dsh-modelselection-footer' },
              h('button', {
                type: 'button',
                className: 'dsh-modelselection-add-trigger',
                disabled: busy || externalDisabled,
                onClick: () => {
                  if (unpicked.length <= INLINE_ADD_LIMIT) setAddingInline(!addingInline)
                  else openLocalPicker()
                },
              },
                plusIcon(),
                unpicked.length <= INLINE_ADD_LIMIT && addingInline
                  ? t('Hide available models', '收起可添加模型')
                  : t(`Add model (${unpicked.length} available)`, `添加模型（还有 ${unpicked.length} 个可选）`)),
              addingInline && unpicked.length <= INLINE_ADD_LIMIT
                ? h('div', { className: 'dsh-modelselection-add-drawer' }, ...unpicked.map((candidate) =>
                  h('button', {
                    key: candidate.id,
                    type: 'button',
                    className: 'dsh-modelselection-add-option',
                    disabled: busy || externalDisabled,
                    onClick: () => void addInline(candidate.id),
                  },
                    plusIcon(),
                    h('code', { className: 'dsh-modelselection-id' }, candidate.id),
                    candidate.name && candidate.name !== candidate.id
                      ? h('span', { className: 'dsh-modelselection-name' }, candidate.name)
                      : null)))
                : null)
            : null),
      globallyHidden.length > 0
        ? h('div', { className: 'dsh-modelselection-global-off' },
          h('span', null, t('Turned off in Exposed models:', '全局已关闭（不参与调度）：')),
          ...globallyHidden.slice(0, 3).map((item) => h('span', {
            key: item.id,
            className: 'dsh-modelselection-global-off-chip',
            title: t('Enable this model in Exposed models on the main page first', '需先在外部「对外可用模型」中开启该模型'),
          }, item.id)),
          globallyHidden.length > 3
            ? h('span', {
              className: 'dsh-modelselection-global-off-chip',
              title: globallyHidden.slice(3).map((item) => item.id).join(', '),
            }, t(`+${globallyHidden.length - 3} more`, `等共 ${globallyHidden.length} 个`))
            : null)
        : null,
      failure ? h('p', { role: 'alert', className: 'dsh-modelselection-error' }, failure) : null,
      h(Modal, {
        open,
        onClose: close,
        backdropBlur: !isCompact,
        title: t('Select models', '选择模型'),
        closeLabel: t('Close', '关闭'),
        description: t('These are the models this provider offers; the checked ones become the model list.', '以下是模型提供商的可用模型，勾选的模型即为模型列表。'),
        footer: [
          h(Button, { key: 'cancel', variant: 'outline', onClick: close }, t('Cancel', '取消')),
          h(Button, {
            key: 'adopt',
            variant: 'outline',
            disabled: picked.length === 0,
            title: picked.length === 0 ? t('Keep at least one model checked.', '请至少保留一个勾选的模型') : undefined,
            onClick: () => void adopt(),
          }, t('Update list', '更新列表')),
        ],
      },
      h('div', { className: 'dsh-modelselection-toolbar' },
        h('input', {
          className: 'dsh-modelselection-search',
          type: 'search',
          value: query,
          placeholder: t('Search models', '搜索模型'),
          'aria-label': t('Search models', '搜索模型'),
          'data-modal-autofocus': '',
          onChange: (event) => setQuery(event.target.value),
        }),
        h(Button, {
          variant: 'ghost',
          size: 'sm',
          disabled: visible.length === 0,
          onClick: () => setFlipped(toggleVisible(flipped, visible, checked)),
        }, allVisiblePicked ? t('Deselect all', '取消全选') : t('Select all', '全选'))),
      visible.length === 0
        ? h('p', { className: 'dsh-modelselection-nomatch', role: 'status' }, t('No matching models.', '没有匹配的模型'))
        : h('ul', { className: 'dsh-modelselection-list' }, ...visible.map((candidate) =>
          h('li', { key: candidate.id, className: 'dsh-modelselection-item' },
            h('label', { className: 'dsh-modelselection-item-label' },
              h('input', {
                type: 'checkbox',
                checked: isPicked(candidate.id, checked, flipped),
                'aria-label': candidate.id,
                onChange: () => setFlipped(toggleId(flipped, candidate.id)),
              }),
              h('code', { title: candidate.name || candidate.id }, candidate.id),
              candidate.name && candidate.name !== candidate.id
                ? h('span', { className: 'dsh-modelselection-name' }, candidate.name)
                : null)))))
    )
  }

  return {
    version: MODEL_SELECTION_VERSION,
    CSS,
    ModelSelectionBlock,
    providerAdapter,
    accountAdapter,
    // 纯函数导出，供单元测试直接覆盖选择代数。
    algebra: { candidatesOf, checkedOf, isPicked, pickedIdsOf, matchesQuery, toggleId, toggleVisible, subsetOf },
  }
}

/**
 * Minimal browser half of dsh-llm-antigravity-acp:
 * 1. Compact weekly-first quota pill beside the composer model seat (strictly hidden unless
 *    an Antigravity model is active; context occupancy uses DSH's native ContextMeter).
 * 2. Concise Settings section for tier and connection controls.
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-antigravity-acp',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const PROVIDER = 'antigravity'
    const PACKAGE = 'dsh-llm-antigravity-acp'
    const SERVICE = 'antigravityAcp'

    const isZh = () => typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')
    const t = (en, cn) => (isZh() ? cn : en)

    // Shared selection UI (bundle-concatenated ahead of this file by the build).
    const { Modal, Button } = require('@deepseek-ai/dsh-client-ui-primitives')
    const MS = createModelSelection({ React, h, t, Modal, Button })

    /** Provider-level allowlist adapter: reads/writes `visibleModels`. */
    const antigravityModelAdapter = (client) => MS.providerAdapter({ client, field: 'visibleModels' })

    const clampInt = (value, min, max, fallback) => {
      const num = Number(value)
      if (!Number.isFinite(num)) return fallback
      return Math.min(max, Math.max(min, Math.round(num)))
    }

    /** Display label the Host gives the machine account when it has no remark. */
    const SYSTEM_ACCOUNT_LABEL = 'This Mac'
    /** Key the Host gives the machine account when it has none of its own. */
    const SYSTEM_ACCOUNT_ID = 'default'

    /**
     * Whether one status payload (or an already extracted `accounts` field) has
     * reported the account list. Every account-list save checks this first: an
     * unreported list must never be mistaken for "no accounts", because
     * submitting that would delete this Mac's own login along with every other
     * entry.
     */
    const accountsLoaded = (source) => Array.isArray(source)
      || (source !== null && typeof source === 'object' && Array.isArray(source.accounts))
    /** The refusal every account-list save reports while the list is unknown. */
    const accountsNotLoaded = () => new Error(t('Account list not loaded yet, try again shortly', '账号列表尚未加载，请稍后重试'))

    /**
     * A row's remark as it should be stored. The machine row reports its
     * default display label when the user never named it, and that label must
     * never be frozen into the profile as if it were a chosen remark.
     */
    const storedDisplayName = (row) => {
      const label = typeof row.label === 'string' ? row.label.trim() : ''
      return row.system === true && label === SYSTEM_ACCOUNT_LABEL ? '' : label
    }

    /** One account profile as the configure request spells it, `system` included. */
    const accountProfileOf = (account, visibleModels) => ({
      id: account.id,
      displayName: storedDisplayName(account),
      home: typeof account.home === 'string' ? account.home : '',
      enabled: account.system === true ? true : account.enabled !== false,
      env: account.env !== null && typeof account.env === 'object' && !Array.isArray(account.env) ? { ...account.env } : {},
      contextWindow: Number(account.contextWindow) || 0,
      ...account.system === true ? { system: true } : {},
      visibleModels: [...visibleModels],
      priority: clampInt(account.priority, 1, 999, 1),
      weight: clampInt(account.weight, 1, 100, 1),
    })

    /**
     * Write one account's model subset. The account list is the whole truth —
     * the machine row is one of its entries — so every row travels back and an
     * unrelated account never loses its value.
     */
    const submitAccountModels = (client, accountId, status, ids) => {
      if (!accountsLoaded(status)) return Promise.reject(accountsNotLoaded())
      return client.configure({
        accounts: status.accounts
          .filter((entry) => entry !== null && typeof entry === 'object')
          .map((entry) => accountProfileOf(entry, entry.id === accountId ? ids : (entry.visibleModels || []))),
      })
    }

    /**
     * Account-level subset adapter: candidates come from the provider's visible
     * models, so an account can only narrow what the provider offers, and the
     * chosen ids are written on that account's own row of the list.
     */
    const antigravityAccountAdapter = (client, accountId, title) => MS.accountAdapter({
      client,
      accountId,
      title,
      fetch: () => client.warmup({ accountId }),
      submit: (status, ids) => submitAccountModels(client, accountId, status, ids),
    })

    function codec(symbol, parse) {
      return { mode: 'strict', typeSymbol: `${PACKAGE}#${symbol}`, create: () => ({ parse }) }
    }
    const anyObject = (value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid antigravity payload')
      return value
    }
    const optionalObject = (value) => (value === undefined || value === null ? undefined : anyObject(value))
    const anyArray = (value) => {
      if (!Array.isArray(value)) throw new TypeError('Invalid antigravity payload')
      return value
    }
    const DESCRIPTORS = [
      { id: `${PACKAGE}#${SERVICE}/status`, service: SERVICE, namespace: SERVICE, method: 'status', invocation: { kind: 'direct' }, parameters: [], result: codec('Status', anyObject) },
      { id: `${PACKAGE}#${SERVICE}/quota`, service: SERVICE, namespace: SERVICE, method: 'quota', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: codec('QuotaRequest', optionalObject) }], result: codec('Quota', anyObject) },
      { id: `${PACKAGE}#${SERVICE}/warmup`, service: SERVICE, namespace: SERVICE, method: 'warmup', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: true, codec: codec('QuotaRequest', optionalObject) }], result: codec('Status', anyObject) },
      { id: `${PACKAGE}#${SERVICE}/configure`, service: SERVICE, namespace: SERVICE, method: 'configure', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: codec('ConfigureRequest', anyObject) }], result: codec('Status', anyObject) },
      { id: `${PACKAGE}#${SERVICE}/accounts`, service: SERVICE, namespace: SERVICE, method: 'accounts', invocation: { kind: 'direct' }, parameters: [], result: codec('Accounts', anyArray) },
      { id: `${PACKAGE}#${SERVICE}/login`, service: SERVICE, namespace: SERVICE, method: 'login', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: codec('LoginRequest', anyObject) }], result: codec('LoginTicket', anyObject) },
      { id: `${PACKAGE}#${SERVICE}/loginCode`, service: SERVICE, namespace: SERVICE, method: 'loginCode', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: codec('LoginCodeRequest', anyObject) }], result: codec('LoginResult', anyObject) },
      { id: `${PACKAGE}#${SERVICE}/cancelLogin`, service: SERVICE, namespace: SERVICE, method: 'cancelLogin', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', acceptsUndefined: false, codec: codec('LoginRequest', anyObject) }], result: codec('Status', anyObject) },
    ]

    // A Typert call envelope is `{ ok: true, value }` or `{ ok: false, error:
    // { message } }`. A payload may carry an `ok` field of its own — the account
    // sign-in result is `{ ok, email, error }` — so the envelope markers, not
    // the `ok` flag, decide which shape a result has.
    const isEnvelope = (result) => result !== null && typeof result === 'object' && 'ok' in result
      && (result.ok === true ? 'value' in result : result.error !== null && typeof result.error === 'object')

    function unwrap(result) {
      if (isEnvelope(result)) {
        if (result.ok) return result.value
        throw new Error((result.error && result.error.message) || 'unknown error')
      }
      return result
    }

    function makeClient(scope) {
      const call = async (method, ...args) => {
        const deadline = Date.now() + 20_000
        for (;;) {
          const service = scope.get(`remote.${SERVICE}`)
          if (service && typeof service[method] === 'function') return unwrap(await service[method](...args))
          if (Date.now() >= deadline) throw new Error(t('Antigravity service is not ready', 'Antigravity 服务尚未就绪'))
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
      }
      return {
        status: () => call('status'),
        /**
         * Status that never waits for the remote service. Background reads
         * (row warm-up, live settings) use this so a page that has not mounted
         * the service yet costs nothing instead of parking a retry loop.
         * @returns the status, or undefined when the service is not mounted.
         */
        statusNow: () => {
          const service = scope.get(`remote.${SERVICE}`)
          if (!service || typeof service.status !== 'function') return Promise.resolve(undefined)
          return Promise.resolve(service.status()).then(unwrap)
        },
        quota: (request) => call('quota', request === true ? { force: true } : request && typeof request === 'object' ? request : undefined),
        warmup: (request) => call('warmup', request && typeof request === 'object' ? request : undefined),
        configure: (patch) => call('configure', patch),
        accounts: () => call('accounts'),
        login: (request) => call('login', request),
        loginCode: (request) => call('loginCode', request),
        cancelLogin: (request) => call('cancelLogin', request),
      }
    }

    const pct = (fraction) => `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`
    // Same compact scale as the harness surfaces beside this pill: K and M are
    // decimal and a sub-100 reading keeps one decimal, so one counter never
    // prints as 1.14M here and 1.2M in the composer.
    const tokens = (n) => {
      const scaled = (value) => (value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10))
      if (n < 1000) return String(Math.round(n))
      if (n < 1_000_000) return `${scaled(n / 1000)}K`
      return `${scaled(n / 1_000_000)}M`
    }
    const isThirdPartyGroup = (group) => {
      const name = (group && group.name) || ''
      return /claude|gpt|oss/i.test(name) && !/gemini/i.test(name)
    }
    const groupKindOf = (group) => {
      if (group && group.kind) return group.kind
      const name = (group && group.name) || ''
      if (/\bargon\b/i.test(name)) return 'argon'
      return isThirdPartyGroup(group) ? 'claude' : 'gemini'
    }
    const quotaFamilyOf = (model) => {
      const lower = String(model || '').toLowerCase()
      if (lower.includes('argon')) return 'argon'
      return /claude|gpt|oss/.test(lower) ? 'claude' : 'gemini'
    }
    /**
     * Windows that govern one model, and whether this account may spend it.
     *
     * The authoritative rules live on the host (`resolveModelQuota` in
     * src/quota.ts) and arrive as `quota.focus`. This local copy only runs for a
     * payload without that focus — a stubbed provider or an older host — and it
     * must never widen one family into another: a Pro plan's untouched Gemini
     * pool is not Argon capacity, which is exactly how a 100% Argon reading
     * appeared beside an account that cannot spend Argon. Returns null when the
     * payload answers a different model than the one on screen.
     */
    const quotaViewFor = (quota, model) => {
      if (!quota || typeof quota !== 'object') return null
      const family = quotaFamilyOf(model)
      const focus = quota.focus
      if (focus && typeof focus === 'object' && focus.model === model) {
        return {
          family: focus.family || family,
          entitled: focus.entitled !== false,
          reason: focus.reason,
          group: focus.entitled === false ? undefined : focus.group,
        }
      }
      if (typeof quota.model === 'string' && quota.model !== model) return null
      const groups = Array.isArray(quota.groups) ? quota.groups : []
      const pick = (kind) => groups.find((group) => groupKindOf(group) === kind)
      const entitledModels = Array.isArray(quota.availableModels) ? quota.availableModels : null
      const disabledModels = Array.isArray(quota.disabledModels) ? quota.disabledModels : []
      const tier = quota.subscriptionTier || null
      const argonDenied = () => disabledModels.some((entry) => entry === model || /argon/i.test(String(entry)))
        || (entitledModels !== null && entitledModels.length > 0
          && !entitledModels.some((entry) => entry && (entry.id === model || /argon/i.test(String(entry.id || '')))))
        || tier === 'PRO' || tier === 'FREE'
      if (family === 'argon') {
        const argon = pick('argon')
        if (argon) return { family, entitled: true, group: argon }
        const gemini = pick('gemini')
        const shared = quota.argonSharedWithGemini === true || tier === 'ULTRA' || tier === 'ENTERPRISE'
        if (gemini && (shared || !argonDenied())) return { family, entitled: true, group: gemini }
        return { family, entitled: false, reason: argonDenied() ? 'model-not-entitled' : 'no-groups' }
      }
      if (family === 'claude') {
        const claude = pick('claude')
        return claude ? { family, entitled: true, group: claude } : { family, entitled: false, reason: 'no-groups' }
      }
      const gemini = pick('gemini')
        ?? (quota.argonSharedWithGemini === true || tier === 'ULTRA' || tier === 'ENTERPRISE' ? pick('argon') : undefined)
      return gemini ? { family, entitled: true, group: gemini } : { family, entitled: false, reason: 'no-groups' }
    }
    const familyName = (group, family) => {
      const name = ((group && group.name) || '').replace(/\s*models?\s*$/i, '').trim()
      if (/claude.*gpt|gpt.*claude/i.test(name)) return t('Claude and GPT', 'Claude 与 GPT')
      if (name.length > 0) return name
      if (family === 'argon') return 'Argon'
      if (family === 'claude') return t('Claude and GPT', 'Claude 与 GPT')
      return t('Antigravity', 'Antigravity')
    }
    const isWeeklyBucket = (b) => !!b && (b.window === 'weekly' || /week/i.test(b.id || '') || /week/i.test(b.name || ''))
    const isShortBucket = (b) => !!b && (b.window === '5h' || /\b5\s*h\b|five[-_\s]*hour/i.test(b.id || '') || /\b5\s*h\b|5\s*小时|five[-_\s]*hour/i.test(b.name || ''))
    // A 5-hour window with no reset is paused: the CLI omits reset_time and sets
    // remaining_fraction to 1 once the weekly window is spent. Showing that as
    // 100% would report quota that cannot be spent.
    const bucketPaused = (b) => !!b && (b.disabled === true || (isShortBucket(b) && !b.resetTime))
    const bucketRank = (b) => (isWeeklyBucket(b) ? 0 : isShortBucket(b) ? 1 : 2)
    const sortBuckets = (buckets) => [...(buckets || [])].sort((a, b) => bucketRank(a) - bucketRank(b))
    const windowLabel = (bucket) => (isShortBucket(bucket) ? t('5h', '5 小时') : isWeeklyBucket(bucket) ? t('Weekly', '每周') : bucket.name)
    const resetLabel = (iso) => {
      const ms = Date.parse(iso) - Date.now()
      if (!Number.isFinite(ms)) return ''
      if (ms <= 0) return t('now', '即将重置')
      const totalMinutes = Math.max(1, Math.round(ms / 60_000))
      const hours = Math.floor(totalMinutes / 60)
      const minutes = totalMinutes % 60
      if (hours >= 24) return t(`${Math.floor(hours / 24)}d ${hours % 24}h`, `${Math.floor(hours / 24)}天${hours % 24}小时`)
      return t(`${hours}h ${minutes}m`, `${hours}小时${minutes}分`)
    }
    const resetPhrase = (iso) => {
      const r = resetLabel(iso)
      if (!r) return ''
      if (r === 'now' || r === '即将重置') return t('Resets now', '即将重置')
      return t(`Resets in ${r}`, `${r}后重置`)
    }
    const pillTitle = (primary, short, error, family) => {
      const label = family || t('Antigravity', 'Antigravity')
      if (!primary) {
        return error ? t(`${label} quota: ${error}`, `${label} 套餐额度：${error}`) : t(`${label} quota`, `${label} 套餐额度`)
      }
      const head = isWeeklyBucket(primary)
        ? t(`${label} weekly quota ${pct(primary.remainingFraction)}`, `${label} 每周额度 ${pct(primary.remainingFraction)}`)
        : t(`${label} ${windowLabel(primary)} quota ${pct(primary.remainingFraction)}`, `${label} ${windowLabel(primary)}额度 ${pct(primary.remainingFraction)}`)
      const r = resetLabel(primary.resetTime)
      const resetPart = !r
        ? ''
        : r === 'now' || r === '即将重置'
          ? t(' (resets now)', '（即将重置）')
          : t(` (resets in ${r})`, `（${r}后重置）`)
      const shortPart = short && short !== primary
        ? t(` · 5h ${pct(short.remainingFraction)}`, ` · 5 小时 ${pct(short.remainingFraction)}`)
        : ''
      return `${head}${resetPart}${shortPart}`
    }

    const toneColor = (fraction) => (fraction < 0.15 ? '#d9534f' : fraction < 0.35 ? '#e0a800' : '#2e9e6a')
    const bar = (fraction, width = 28, height = 4) => h('span', {
      'aria-hidden': 'true',
      style: {
        display: width === '100%' ? 'block' : 'inline-block',
        width,
        height,
        borderRadius: 999,
        background: 'color-mix(in srgb, currentColor 16%, transparent)',
        overflow: 'hidden',
        verticalAlign: 'middle',
        flexShrink: 0,
      },
    }, h('span', {
      style: {
        display: 'block',
        height: '100%',
        width: pct(fraction),
        borderRadius: 999,
        background: toneColor(fraction),
      },
    }))

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    // One scoped stylesheet for every control this package draws: the shipped
    // model-menu cell geometry, so a provider row inside the composer menu and
    // a row inside the Settings section read as the same component. Colors are
    // --dsw-alias-* tokens so every theme keeps working.
    const ROW_CSS = [
      '.dsh-agy-list{display:flex;flex-direction:column}',
      '.dsh-agy-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left}',
      'button.dsh-agy-row{cursor:pointer;outline:none}',
      // A disabled row must stay readable: only the pointer and a light fade
      // change, never the label color (the dimmed token washes out on white).
      'button.dsh-agy-row:disabled{cursor:default;opacity:.55}',
      'button.dsh-agy-row:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-agy-row[aria-expanded="true"]{background:color-mix(in srgb, currentColor 4%, transparent)}',
      '@media(hover:hover){button.dsh-agy-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}',
      '.dsh-agy-label{flex:0 0 auto;display:inline-flex;align-items:center;white-space:nowrap;color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dsh-agy-hint{display:inline-flex;align-items:center;margin-left:6px;color:var(--dsw-alias-label-tertiary);cursor:help}',
      '.dsh-agy-value{flex:1 1 auto;min-width:0;text-align:right;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.dsh-agy-row[data-interactive="true"] .dsh-agy-value{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-agy-chevron{flex:0 0 auto;width:12px;height:12px;color:var(--dsw-alias-menu-icon);transition:transform 120ms ease}',
      '.dsh-agy-options{display:flex;flex-direction:column;margin:2px 0 4px 10px;padding-left:6px;border-left:1.5px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 14%, transparent))}',
      '.dsh-agy-option{min-height:30px;padding-left:10px}',
      '.dsh-agy-option .dsh-agy-value{display:inline-flex;justify-content:flex-end;align-items:center}',
      '.dsh-agy-check{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;color:var(--dsw-alias-label-primary)}',
      '.dsh-agy-stack{display:flex;flex-wrap:wrap;gap:10px 14px;justify-content:flex-end}',
      // Settings section: a calm card surface that matches the native DSH
      // settings page rather than the dense geometry of the composer menu.
      '.antigravity-settings-card{box-sizing:border-box;max-width:680px;display:flex;flex-direction:column;gap:16px;padding:4px 0 12px;color:var(--dsw-alias-label-primary)}',
      '.dsh-agy-header{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dsh-agy-header h3{font-size:16px;font-weight:600;line-height:24px;margin:0;color:var(--dsw-alias-label-primary)}',
      '.dsh-agy-settings-body{display:flex;flex-direction:column;gap:18px;min-width:0}',
      '.dsh-agy-card{display:flex;flex-direction:column;padding:2px 6px;border:0.5px solid var(--dsw-alias-settings-card-stroke, color-mix(in srgb, currentColor 14%, transparent));border-radius:var(--dsw-radius-xl, 20px);background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, transparent))}',
      '.antigravity-settings-card .dsh-agy-card > .dsh-agy-row{min-height:42px;padding:8px 10px;border-radius:0}',
      '.antigravity-settings-card .dsh-agy-card > .dsh-agy-list{padding:2px 0}',
      '.antigravity-settings-card .dsh-agy-card > .dsh-agy-list > .dsh-agy-row{min-height:38px;padding:6px 10px;border-radius:var(--dsw-radius-md, 12px)}',
      '.antigravity-settings-card .dsh-agy-card > * + *{border-top:0.5px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 10%, transparent))}',
      '.antigravity-settings-card .dsh-agy-options{margin:2px 4px 6px 10px;padding:4px;border-left:0;border-radius:var(--dsw-radius-md, 12px);background:var(--dsw-alias-bg-module-platform, color-mix(in srgb, currentColor 4%, transparent))}',
      '.antigravity-settings-card .dsh-agy-options .dsh-agy-option{min-height:32px;padding:0 10px;border-radius:var(--dsw-radius-sm, 8px)}',
      '.antigravity-settings-card .dsh-agy-options .dsh-agy-option[aria-checked="true"]{background:var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 7%, transparent))}',
      // Buttons and inputs: one shared surface driven by DSH theme tokens.
      '.dsh-agy-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:5px;font:inherit;font-size:11px;line-height:18px;padding:1px 8px;border-radius:6px;white-space:nowrap;border:0.5px solid var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 16%, transparent));background:transparent;color:var(--dsw-alias-label-primary);outline:none;cursor:pointer;transition:background 120ms ease,border-color 120ms ease,box-shadow 120ms ease}',
      '.dsh-agy-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 6%, transparent))}',
      '.dsh-agy-btn:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6))}',
      '.dsh-agy-btn:disabled{opacity:.45;cursor:default}',
      '.dsh-agy-btn-primary{background:var(--dsw-alias-button-primary-fill, #0f1115);border-color:transparent;color:var(--dsw-alias-label-primary-foreground, #fff);font-weight:500}',
      '.dsh-agy-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover, #43454a);border-color:transparent}',
      '.dsh-agy-btn-danger{color:var(--dsw-alias-state-error-primary, #d9534f);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary, #d9534f) 32%, transparent)}',
      '.dsh-agy-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger, color-mix(in srgb, #d9534f 8%, transparent));border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary, #d9534f) 55%, transparent)}',
      '.dsh-agy-input{box-sizing:border-box;font:inherit;font-size:12px;line-height:20px;min-width:0;padding:2px 8px;border-radius:6px;border:0.5px solid var(--dsw-alias-border-l4, color-mix(in srgb, currentColor 18%, transparent));background:var(--dsw-alias-bg-layer-3, transparent);color:var(--dsw-alias-label-primary);outline:none;transition:border-color 120ms ease,box-shadow 120ms ease}',
      '.dsh-agy-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-agy-input:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 32%, transparent))}',
      '.dsh-agy-input:focus-visible{border-color:var(--dsw-alias-state-business-primary, #4176e6);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 18%, transparent)}',
      // Status badge, version/context tags and quota pill chips.
      '.dsh-agy-dot{display:inline-block;width:7px;height:7px;border-radius:999px;flex:0 0 auto}',
      '.dsh-agy-badge{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:11px;line-height:18px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-module-platform, color-mix(in srgb, currentColor 6%, transparent));color:var(--dsw-alias-label-primary)}',
      '.dsh-agy-badge-system{padding:1px 7px;font-size:11px;background:color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 12%, transparent);color:var(--dsw-alias-state-business-primary, #4176e6)}',
      '.dsh-agy-tier{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;font-weight:500;letter-spacing:0.02em;white-space:nowrap;background:var(--dsw-alias-bg-module-platform, color-mix(in srgb, currentColor 7%, transparent));color:var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))}',
      '.dsh-agy-tier-ultra{background:color-mix(in srgb, #7c3aed 13%, transparent);color:#7c3aed}',
      '.dsh-agy-tier-pro{background:color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 13%, transparent);color:var(--dsw-alias-state-business-primary, #4176e6)}',
      '.dsh-agy-tier-enterprise{background:color-mix(in srgb, #0d9488 13%, transparent);color:#0d9488}',
      '.dsh-agy-sched{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;font-size:11px;line-height:18px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;background:var(--dsw-alias-bg-module-platform, color-mix(in srgb, currentColor 6%, transparent));color:var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary, currentColor))}',
      '.dsh-agy-modal{width:min(540px, calc(100vw - 32px)) !important;max-width:540px !important}',
      '.dsh-agy-editor-modal{display:flex;flex-direction:column;gap:14px;padding:4px 0;width:100%;min-width:0;box-sizing:border-box}',
      '.dsh-agy-grid2{display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:12px}',
      '.dsh-agy-stat-box{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-module-platform, color-mix(in srgb, currentColor 4%, transparent));border:0.5px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 9%, transparent))}',
      '.dsh-agy-stat-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsh-agy-stat-hint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary, currentColor);margin:0}',
      '.dsh-agy-stepper{display:inline-flex;align-items:center;gap:6px}',
      '.dsh-agy-step-btn{box-sizing:border-box;width:30px;height:30px;padding:0;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 18%, transparent));background:var(--dsw-alias-bg-layer-3, transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}',
      '@media(hover:hover){.dsh-agy-step-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 6%, transparent))}}',
      '.dsh-agy-step-btn:disabled{opacity:.4;cursor:default}',
      '.dsh-agy-quota-note{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary, currentColor);padding:4px 4px 0;border-top:0.5px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 9%, transparent))}',
      '.dsh-agy-tag{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;line-height:18px;white-space:nowrap;font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-module-platform, color-mix(in srgb, currentColor 5%, transparent));color:var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary, currentColor))}',
      '.dsh-agy-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11px;line-height:18px;white-space:nowrap;background:var(--dsw-alias-bg-module-platform, color-mix(in srgb, currentColor 5%, transparent));border:0.5px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 10%, transparent))}',
      '.dsh-agy-chip-label{font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsh-agy-chip-pct{font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.dsh-agy-chip-reset{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      // Account pool.
      '.dsh-agy-accounts{display:flex;flex-direction:column;gap:10px}',
      '.dsh-agy-accounts-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px}',
      '.dsh-agy-accounts-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsh-agy-count{font-size:11px;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-bg-module-platform, color-mix(in srgb, currentColor 6%, transparent));color:var(--dsw-alias-label-tertiary, currentColor);font-variant-numeric:tabular-nums}',
      '.dsh-agy-account-list{display:flex;flex-direction:column;gap:10px}',
      '.dsh-agy-account-card{display:flex;flex-direction:column;gap:10px;padding:12px 16px;border:0.5px solid var(--dsw-alias-settings-card-stroke, color-mix(in srgb, currentColor 14%, transparent));border-radius:var(--dsw-radius-xl, 20px);background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, transparent))}',
      '.dsh-agy-account-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:nowrap}',
      '.dsh-agy-account-identity{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 auto}',
      '.dsh-agy-avatar{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;flex:0 0 36px;border-radius:var(--dsw-radius-md, 10px);background:var(--dsw-alias-bg-module-platform, color-mix(in srgb, currentColor 6%, transparent));color:var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary, currentColor))}',
      '.dsh-agy-account-meta{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.dsh-agy-account-line{display:flex;align-items:center;flex-wrap:wrap;gap:5px}',
      '.dsh-agy-account-title{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary);cursor:text;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px}',
      '.dsh-agy-account-sub{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary, currentColor)}',
      '.dsh-agy-account-email{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}',
      '.dsh-agy-account-sessions{font-variant-numeric:tabular-nums}',
      '.dsh-agy-account-actions{display:flex;align-items:center;gap:5px;flex:0 0 auto}',
      '.dsh-agy-remove-confirm{display:inline-flex;align-items:center;gap:5px}',
      '.dsh-agy-btn[aria-pressed="true"]{background:color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 35%, transparent);color:var(--dsw-alias-state-business-primary, #4176e6);font-weight:500}',
      '.dsh-agy-quota-drawer{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-module-platform, color-mix(in srgb, currentColor 4%, transparent));border:0.5px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 9%, transparent))}',
      '.dsh-agy-quota-drawer > .dsh-agy-row{min-height:32px;padding:2px 4px}',
      '.dsh-agy-quota-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 4px 2px}',
      '.dsh-agy-quota-title{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary, currentColor))}',
      '.dsh-agy-degrade-pill{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;margin-left:2px;border-radius:999px;font-size:11px;line-height:16px;font-weight:500;background:color-mix(in srgb, #e0a800 16%, transparent);color:var(--dsw-alias-state-warning-primary, #b45309)}',
      '.dsh-agy-degrade-dot{display:inline-block;width:5px;height:5px;border-radius:999px;background:#e0a800;flex:0 0 auto}',
      '.dsh-agy-degrade-card{margin-top:9px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb, #e0a800 9%, transparent);border:1px solid color-mix(in srgb, #e0a800 28%, transparent);display:flex;flex-direction:column;gap:6px;white-space:normal}',
      '.dsh-agy-healed-note{margin-top:9px;padding:6px 9px;border-radius:8px;font-size:11px;line-height:15px;white-space:normal;background:color-mix(in srgb, #2e9e6a 10%, transparent);color:var(--dsw-alias-label-secondary, currentColor)}',
      '.dsh-agy-degrade-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;line-height:16px}',
      '.dsh-agy-degrade-title{display:inline-flex;align-items:center;gap:5px;font-weight:500;color:var(--dsw-alias-state-warning-primary, #b45309)}',
      '.dsh-agy-degrade-tags{display:flex;flex-wrap:wrap;gap:4px}',
      '.dsh-agy-degrade-tag{display:inline-flex;align-items:center;padding:1px 6px;border-radius:5px;font-size:10.5px;line-height:15px;font-variant-numeric:tabular-nums;background:color-mix(in srgb, currentColor 6%, transparent);color:var(--dsw-alias-label-primary, inherit)}',
      // Account panel chrome: field rows, alerts, the sign-in ticket, and the
      // button shapes the panel would otherwise re-declare at every call site.
      '.dsh-agy-inline-row{display:flex;align-items:center;gap:8px}',
      '.dsh-agy-inline-row-wrap{display:flex;align-items:center;flex-wrap:wrap;gap:8px}',
      '.dsh-agy-inline-row > .dsh-agy-label,.dsh-agy-inline-row-wrap > .dsh-agy-label{flex:0 0 72px}',
      '.dsh-agy-number-input{width:64px;height:30px;text-align:center;padding:0 6px;font-variant-numeric:tabular-nums}',
      '.dsh-agy-usage{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary, currentColor)}',
      '.dsh-agy-cooldowns{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:#e0a800;background:color-mix(in srgb, #e0a800 10%, transparent);padding:6px 10px;border-radius:8px}',
      '.dsh-agy-row-alert{color:#d9534f;font-size:12px;padding:4px 8px;background:color-mix(in srgb, #d9534f 10%, transparent);border-radius:6px;white-space:normal}',
      '.dsh-agy-row-notice{color:#2e9e6a;font-size:12px;padding:4px 8px;background:color-mix(in srgb, #2e9e6a 10%, transparent);border-radius:6px;white-space:normal}',
      '.dsh-agy-account-error{font-size:12px;color:#d9534f;padding:6px 10px;background:color-mix(in srgb, #d9534f 10%, transparent);border-radius:8px}',
      '.dsh-agy-error-text{color:#d9534f;font-size:12px;white-space:normal}',
      '.dsh-agy-ticket{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:12px;background:color-mix(in srgb, currentColor 5%, transparent);border:0.5px solid var(--dsw-alias-settings-card-stroke, color-mix(in srgb, currentColor 12%, transparent))}',
      // One copyable line: the wrapped text keeps every remaining pixel and the
      // copy control keeps its own, so neither squeezes the other at any width.
      '.dsh-agy-ticket-row{display:flex;align-items:flex-start;gap:6px;min-width:0}',
      '.dsh-agy-ticket-row > .dsh-agy-ticket-link,.dsh-agy-ticket-row > .dsh-agy-ticket-command{flex:1 1 auto;min-width:0}',
      '.dsh-agy-ticket-link{color:var(--dsw-alias-label-link, #2f6feb);font-size:13px;overflow-wrap:anywhere}',
      '.dsh-agy-ticket-command{font-size:12px;opacity:0.9;white-space:pre-wrap;overflow-wrap:anywhere;padding:6px 8px;background:color-mix(in srgb, currentColor 10%, transparent);border-radius:6px}',
      // A quiet icon action that still reads as a target: the same hairline
      // border as the panel's other buttons, no fill until hover, and a
      // success tick that replaces the glyph instead of resizing the row.
      '.dsh-agy-copy{box-sizing:border-box;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin-top:-2px;padding:0;border:0.5px solid var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 16%, transparent));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary, var(--dsw-alias-label-tertiary, currentColor));cursor:pointer;outline:none;transition:background 120ms ease,color 120ms ease,border-color 120ms ease}',
      '@media(hover:hover){.dsh-agy-copy:hover{background:var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent));border-color:var(--dsw-alias-border-l4, color-mix(in srgb, currentColor 24%, transparent));color:var(--dsw-alias-label-primary)}}',
      '.dsh-agy-copy:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6))}',
      '.dsh-agy-copy[data-copied="true"]{color:var(--dsw-alias-state-success-primary, #2e9e6a)}',
      '.dsh-agy-copy .dsh-agy-check{width:14px;height:14px}',
      '.dsh-agy-quota-loading{font-size:12px;opacity:0.68;padding:2px 4px}',
      '.dsh-agy-quota-error{font-size:12px;color:#d9534f;padding:2px 4px}',
      // Chips stack inside a row: tighter than the wrapping badge stack.
      '.dsh-agy-stack-tight{justify-content:flex-end;gap:6px;flex-wrap:nowrap}',
      // Button shapes that repeat across the panel; declared after .dsh-agy-btn
      // so they win on equal specificity, and before any inline override.
      '.dsh-agy-btn-row{padding:4px 10px}',
      '.dsh-agy-btn-mini{height:24px;padding:0 8px}',
      '.dsh-agy-btn-dialog{height:34px;padding:0 14px}',
      '.dsh-agy-btn-dialog-start{height:34px;padding:0 12px;margin-right:auto}',
      '.dsh-agy-btn-settings{padding:3px 12px}',
    ].join('\n') + '\n' + MS.CSS
    const STYLE_ID = 'antigravity-acp-rows-style'
    function ensureStyles() {
      const doc = typeof document === 'undefined' ? undefined : document
      if (!doc || !doc.createElement || !doc.head || !doc.head.appendChild) return
      const existing = doc.getElementById ? doc.getElementById(STYLE_ID) : null
      if (existing) {
        existing.textContent = ROW_CSS
        return
      }
      const style = doc.createElement('style')
      style.id = STYLE_ID
      style.textContent = ROW_CSS
      doc.head.appendChild(style)
    }

    const chevron = (open) => h('svg', {
      className: 'dsh-agy-chevron',
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      style: open ? { transform: 'rotate(90deg)' } : undefined,
    }, h('path', {
      d: 'M9 6l6 6-6 6', stroke: 'currentColor', 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }))

    const checkMark = () => h('span', { className: 'dsh-agy-check', 'aria-hidden': 'true' },
      h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none' },
        h('path', {
          d: 'M5 13l4 4L19 7', stroke: 'currentColor', 'stroke-width': 2,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        })))

    /** Semantic dot color for the provider status badge. */
    const stateDotColor = (state) => ({
      ready: '#2e9e6a',
      starting: '#e0a800',
      error: '#d9534f',
      idle: 'var(--dsw-alias-label-tertiary, currentColor)',
    }[state] || 'var(--dsw-alias-label-tertiary, currentColor)')

    // Text-free decorative glyphs. `aria-hidden` keeps them out of the
    // accessibility tree and, importantly, out of any textOf() reading.
    const refreshIcon = () => h('svg', {
      viewBox: '0 0 24 24', width: 13, height: 13, fill: 'none',
      'aria-hidden': 'true', style: { flexShrink: 0 },
    }, h('path', {
      d: 'M20 11a8 8 0 1 0-2.4 5.7M20 5v6h-6',
      stroke: 'currentColor', 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }))

    const accountGlyph = (system) => h('svg', {
      viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', 'aria-hidden': 'true',
    }, h('path', {
      d: system
        ? 'M3 5.5h18v11H3zM8 20h8M12 16.5V20M7 9.5l2 2-2 2M12 13.5h4'
        : 'M12 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM5 20c0-3.6 3.1-6 7-6s7 2.4 7 6',
      stroke: 'currentColor', 'stroke-width': 1.7,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }))

    /** A glyph mark. The explanation lives on `title`, so row text stays the label and value. */
    const Hint = (props) => h('span', { className: 'dsh-agy-hint', title: props.text, 'aria-label': props.text },
      h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 8, cy: 8, r: 6.25, stroke: 'currentColor', 'stroke-width': 1.2 }),
        h('path', {
          d: 'M8 11.3v.15M6.55 6.35a1.45 1.45 0 1 1 2.15 1.25c-.45.3-.7.6-.7 1.15V9.1',
          stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round',
        })))

    /**
     * One setting as a row: label on the left, the current value and a chevron
     * on the right, and the available values as a check-marked list that opens
     * inline. The composer menu needs `menuitem`/`menuitemradio` roles so DSH's
     * arrow-key routing reaches the rows; a Settings section uses plain buttons.
     */
    function ChoiceRow(props) {
      // Controlled when the parent passes `open` (mutually-exclusive accordion);
      // otherwise keep the historical self-managed state for standalone uses.
      const [innerOpen, setInnerOpen] = React.useState(false)
      const isControlled = typeof props.open === 'boolean'
      const isOpen = isControlled ? props.open : innerOpen
      const toggle = (next) => {
        if (isControlled) {
          if (typeof props.onToggle === 'function') props.onToggle(next)
        } else {
          setInnerOpen(next)
        }
      }
      const current = props.options.find((option) => option.value === props.value)
      const menu = props.menu === true
      return h('div', { className: 'dsh-agy-list' },
        h('button', {
          type: 'button',
          ref: props.buttonRef || undefined,
          ...(menu ? { role: 'menuitem' } : {}),
          'aria-expanded': isOpen,
          'aria-label': `${props.label} ${current ? current.label : ''}`.trim(),
          disabled: props.disabled,
          'data-interactive': 'true',
          className: 'dsh-agy-row',
          onClick: () => { if (!props.disabled) toggle(!isOpen) },
        },
          h('span', { className: 'dsh-agy-label' }, props.label, props.hint ? h(Hint, { text: props.hint }) : null),
          h('span', { className: 'dsh-agy-value' }, current ? current.label : '—'),
          chevron(isOpen)),
        isOpen ? h('div', { className: 'dsh-agy-options' },
          ...props.options.map((option) => h('button', {
            key: String(option.value),
            type: 'button',
            ...(menu ? { role: 'menuitemradio' } : {}),
            'aria-checked': option.value === props.value,
            disabled: props.disabled,
            className: 'dsh-agy-row dsh-agy-option',
            onClick: () => {
              if (props.disabled) return
              toggle(false)
              props.onChange(option.value)
            },
          },
            h('span', { className: 'dsh-agy-label' }, option.label),
            h('span', { className: 'dsh-agy-value' }, option.value === props.value ? checkMark() : null)))) : null)
    }

    /**
     * A read-only row: same geometry as {@link ChoiceRow} without hover, focus,
     * chevron, or expansion.
     */
    function InfoRow(props) {
      return h('div', { className: 'dsh-agy-row' },
        h('span', { className: 'dsh-agy-label' }, props.label),
        h('span', { className: 'dsh-agy-value' }, props.children ?? props.value))
    }

    /** Longest remark the settings card accepts. Matches `MAX_ACCOUNT_REMARK`. */
    const REMARK_LIMIT = 64
    /** Pending marker for the add row, which has no account key of its own yet. */
    const ADD_PENDING = '__draft__'
    /** Pending marker for the "use this Mac's login" row, which owns no key yet either. */
    const USE_SYSTEM_PENDING = '__system__'
    const PROXY_ENV_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy']
    const LOOPBACK_NO_PROXY = '127.0.0.1,localhost,::1'

    /** One account proxy URL. A missing scheme is read as HTTP. */
    const normalizeProxyUrl = (raw) => {
      const trimmed = String(raw ?? '').trim()
      if (trimmed.length === 0) return ''
      const withScheme = trimmed.includes('://') ? trimmed : `http://${trimmed}`
      let parsed
      try { parsed = new URL(withScheme) } catch { throw new Error(t('Invalid proxy URL', '代理地址无效')) }
      const scheme = parsed.protocol.slice(0, -1)
      if (!['http', 'https', 'socks5', 'socks5h'].includes(scheme)) throw new Error(t('Use an http, https, socks5, or socks5h proxy', '请使用 http、https、socks5 或 socks5h 代理'))
      if (!parsed.hostname) throw new Error(t('Proxy URL is missing a host', '代理地址缺少主机'))
      return withScheme
    }
    const envWithProxy = (env, proxyUrl) => {
      const next = {}
      const source = env !== null && typeof env === 'object' && !Array.isArray(env) ? env : {}
      for (const [key, value] of Object.entries(source)) {
        if (!PROXY_ENV_NAMES.includes(key) && typeof value === 'string') next[key] = value
      }
      const url = normalizeProxyUrl(proxyUrl)
      if (url.length === 0) return next
      return {
        ...next,
        HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url,
        http_proxy: url, https_proxy: url, all_proxy: url,
        NO_PROXY: LOOPBACK_NO_PROXY, no_proxy: LOOPBACK_NO_PROXY,
      }
    }

    /** Collapse whitespace the same way the host stores a remark. */
    const cleanRemark = (value) => String(value ?? '').trim().replace(/\s+/g, ' ')

    /**
     * Directory key for a new account. The person never sees or types it.
     * A fresh key avoids reusing the login directory of an account they removed.
     */
    const freshAccountId = (existing) => {
      const used = new Set(existing.map((row) => row && typeof row.id === 'string' ? row.id : '').filter(Boolean))
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
      const bytes = new Uint8Array(8)
      for (;;) {
        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
        else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
        let suffix = ''
        for (let i = 0; i < bytes.length; i += 1) suffix += alphabet[bytes[i] % alphabet.length]
        const id = `acc-${suffix}`
        if (!used.has(id)) return id
      }
    }

    const accountFamilyLabel = (family) => {
      if (family === 'argon') return 'Gemini 4 Argon'
      if (family === 'gemini') return 'Gemini'
      if (family === 'claude') return 'Claude'
      if (family === 'gpt-oss') return 'GPT-OSS'
      return String(family || '')
    }

    /** Remaining time of one exhausted quota family, down to the minute. */
    const cooldownLabel = (iso) => {
      const ms = Date.parse(iso) - Date.now()
      if (!Number.isFinite(ms)) return ''
      const minutes = Math.max(0, Math.ceil(ms / 60_000))
      if (minutes <= 0) return t('now', '即将')
      if (minutes < 60) return t(`${minutes}m`, `${minutes} 分`)
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return rest === 0 ? t(`${hours}h`, `${hours} 小时`) : t(`${hours}h ${rest}m`, `${hours} 小时 ${rest} 分`)
    }

    /**
     * Compact secondary control of the account rows. The layout (font, padding,
     * radius) lives in the .dsh-agy-btn stylesheet; `variant` picks the shared
     * surface, `className` lets a caller extend it, and `style` is merged LAST
     * so call-site intent (primary fill, danger red, equal heights, extra
     * padding) is never silently discarded.
     */
    function SmallButton(props) {
      const disabled = props.disabled === true
      const variant = props.variant || 'default'
      const className = [
        'dsh-agy-btn',
        variant === 'primary' ? 'dsh-agy-btn-primary' : variant === 'danger' ? 'dsh-agy-btn-danger' : '',
        props.className || '',
      ].filter(Boolean).join(' ')
      return h('button', {
        type: 'button',
        className,
        disabled,
        onClick: props.onClick,
        style: {
          opacity: disabled ? 0.45 : 1,
          cursor: disabled ? 'default' : 'pointer',
          ...(props.style || {}),
        },
      }, props.children)
    }

    /**
     * Place text on the host clipboard. The async Clipboard API is preferred —
     * it needs the click's user activation, which the copy control keeps.
     * jsdom, insecure origins, and older hosts omit it, so a hidden textarea
     * plus `execCommand('copy')` stays as the documented fallback.
     */
    async function copyText(text) {
      const value = String(text ?? '')
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard !== null
          && typeof navigator.clipboard === 'object' && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch { /* an explicit denial falls through to the fallback path */ }
      try {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function'
          || document.body === null || document.body === undefined) return false
        const area = document.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = typeof document.execCommand === 'function' && document.execCommand('copy') === true
        area.remove()
        return ok
      } catch { return false }
    }

    /** Two offset rounded squares: the platform-neutral "copy" glyph. */
    const copyIcon = () => h('svg', {
      viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none',
      'aria-hidden': 'true', style: { flexShrink: 0 },
    }, h('path', {
      d: 'M9.5 9.5h7a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 8 18v-7a1.5 1.5 0 0 1 1.5-1.5zM5 15h-.5A1.5 1.5 0 0 1 3 13.5v-7A1.5 1.5 0 0 1 4.5 5h7A1.5 1.5 0 0 1 13 6.5V7',
      stroke: 'currentColor', 'stroke-width': 1.7,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }))

    /**
     * One clipboard action for a read-only line of the sign-in hand-off. The
     * success tick lives inside this control, so copying never re-renders the
     * card around it and the tick can never land on the wrong row.
     */
    function CopyButton(props) {
      const [copied, setCopied] = React.useState(false)
      const timer = React.useRef(null)
      React.useEffect(() => () => {
        if (timer.current !== null) {
          clearTimeout(timer.current)
          timer.current = null
        }
      }, [])
      const label = copied ? t('Copied', '已复制') : props.label
      const onCopy = () => {
        if (copied) return
        void copyText(props.text).then((ok) => {
          if (!ok) return
          setCopied(true)
          if (timer.current !== null) clearTimeout(timer.current)
          timer.current = setTimeout(() => {
            timer.current = null
            setCopied(false)
          }, 1400)
        })
      }
      return h('button', {
        type: 'button',
        className: 'dsh-agy-copy',
        'data-agy-copy': props.kind,
        'data-copied': copied ? 'true' : undefined,
        title: label,
        'aria-label': label,
        onClick: onCopy,
      }, copied ? checkMark() : copyIcon())
    }

    // ── Account helpers shared by the panel, its cards, and its dialog ──────────

    /** Remark exactly as the Host stores it: trimmed, empty when absent. */
    const remarkOf = (row) => (typeof row.label === 'string' ? row.label.trim() : '')
    /** A row with a keychain email has a credential; a blank one still needs sign-in. */
    const signedIn = (row) => typeof row.email === 'string' && row.email.length > 0
    /** Title of a card and of its editor: remark, then email, then a placeholder. */
    const accountTitle = (row) => {
      if (row.system === true) {
        const custom = remarkOf(row)
        return custom && custom !== 'This Mac' ? custom : t('This Mac', '本机')
      }
      return remarkOf(row) || (signedIn(row) ? row.email : t('Untitled', '未命名'))
    }

    /** The proxy URL of one account env, whatever spelling it was stored with. */
    const proxyFrom = (env) => {
      if (env === null || typeof env !== 'object' || Array.isArray(env)) return ''
      return env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy || ''
    }

    /** Editable copy of one account, as the editor opens on it. */
    const baseDraft = (row) => ({
      remark: storedDisplayName(row),
      priority: clampInt(row.priority, 1, 999, 1),
      weight: clampInt(row.weight, 1, 100, 1),
      proxy: proxyFrom(row.env),
      contextWindow: Number(row.contextWindow) || 0,
      visibleModels: Array.isArray(row.visibleModels) ? [...row.visibleModels] : [],
    })

    /** Window chips of one quota family: weekly first, paused windows dimmed. */
    const quotaChips = (buckets) => h('span', { className: 'dsh-agy-stack dsh-agy-stack-tight' },
      ...sortBuckets(buckets).map((b) => {
        const paused = bucketPaused(b)
        return h('span', {
          key: b.id,
          className: 'dsh-agy-chip',
          'data-bucket-window': b.window || b.id,
          ...(paused ? { 'data-bucket-disabled': 'true' } : {}),
          style: paused ? { opacity: 0.72 } : undefined,
        },
          h('span', { className: 'dsh-agy-chip-label' }, windowLabel(b)),
          paused ? null : bar(b.remainingFraction, 28, 4),
          h('span', { className: 'dsh-agy-chip-pct' }, paused ? t('n/a', '不适用') : pct(b.remainingFraction)),
          paused ? null : h('span', { className: 'dsh-agy-chip-reset' }, resetLabel(b.resetTime)))
      }))

    const quotaRow = (group, label) => (group && (group.buckets || []).length > 0
      ? h(InfoRow, { label }, quotaChips(group.buckets))
      : null)

    const miniChevron = (open) => h('svg', {
      viewBox: '0 0 24 24', width: 12, height: 12, fill: 'none', 'aria-hidden': 'true',
      style: { flexShrink: 0, transition: 'transform 120ms ease', transform: open ? 'rotate(180deg)' : undefined },
    }, h('path', {
      d: 'M6 9l6 6 6-6', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }))

    const quotaGroupLabel = (group) => {
      const raw = String((group && group.name) || '').trim()
      if (raw === 'Gemini Models' || raw === 'Gemini') return t('Gemini quota', 'Gemini 额度')
      if (raw === 'Claude and GPT models' || raw === 'Claude') return t('Claude quota', 'Claude 额度')
      if (group && group.kind === 'argon') return t('Gemini 4 Argon (weekly)', 'Gemini 4 Argon（独立周限）')
      if (raw === 'Gemini 4 Carbon / Argon' || raw === 'Gemini 4 Carbon / Argon / 3.8') return t('Gemini / Carbon / Argon quota', 'Gemini / Carbon / Argon 额度')
      if (raw === 'Gemini 4 Argon / 3.8') return t('Gemini / Argon quota', 'Gemini / Argon 额度')
      if (raw === 'Gemini 3.8 Flash') return t('Gemini 3.8 quota', 'Gemini 3.8 额度')
      return t(`${raw} quota`, `${raw} 额度`)
    }

    const tierBadge = (tier, tierName) => {
      const key = String(tier || '').trim().toUpperCase()
      if (!key) return null
      const mod = key === 'ULTRA' ? ' dsh-agy-tier-ultra'
        : key === 'PRO' ? ' dsh-agy-tier-pro'
          : key === 'ENTERPRISE' ? ' dsh-agy-tier-enterprise' : ''
      return h('span', {
        className: `dsh-agy-tier${mod}`,
        title: tierName || key,
        'data-agy-tier': key,
      }, key)
    }

    const schedBadge = (row) => {
      const p = clampInt(row.priority, 1, 999, 1)
      const w = clampInt(row.weight, 1, 100, 1)
      const label = w > 1 ? `P${p} · ×${w}` : `P${p}`
      return h('span', {
        className: 'dsh-agy-sched',
        'data-agy-sched': `${p}:${w}`,
        title: t(`Priority ${p} · Weight ${w}`, `优先级 ${p} · 权重 ${w}`),
      }, label)
    }

    // ── Account pool components ────────────────────────────────────────────────

    /**
     * Read-only quota drawer of one account: the per-family windows plus the
     * entitled-model note. Values arrive through props; the panel owns the read,
     * the loading flag, and the open/closed state.
     */
    function AccountQuotaDrawer(props) {
      const row = props.row
      const quota = props.quota
      const loading = props.loading === true
      const busy = props.busy === true
      const groups = quota && Array.isArray(quota.groups) ? quota.groups : []
      const planName = (quota && quota.subscriptionName) || row.subscriptionName || ''
      const headTitle = planName
        ? t(`Account quota · ${planName}`, `账号额度 · ${planName}`)
        : t('Account quota', '账号额度')
      const entitled = (quota && Array.isArray(quota.availableModels) && quota.availableModels.length > 0)
        ? quota.availableModels
        : (Array.isArray(row.availableModels) && (row.subscriptionTier || (quota && quota.subscriptionTier)) ? row.availableModels : [])
      const disabledList = (quota && Array.isArray(quota.disabledModels) ? quota.disabledModels : (Array.isArray(row.disabledModels) ? row.disabledModels : []))
      return h('div', { className: 'dsh-agy-quota-drawer', 'data-agy-quota': row.id },
        h('div', { className: 'dsh-agy-quota-head' },
          h('span', { className: 'dsh-agy-quota-title' }, headTitle),
          h(SmallButton, {
            disabled: busy || loading,
            onClick: props.onRefresh,
            className: 'dsh-agy-btn-mini',
          }, loading ? '…' : t('Refresh', '刷新'))),
        !quota && loading
          ? h('div', { className: 'dsh-agy-quota-loading' }, t('Loading…', '读取中…'))
          : quota && quota.status === 'error' && groups.length === 0
            ? h('div', { className: 'dsh-agy-quota-error' }, quota.error || t('Quota is unavailable', '额度不可用'))
            : h('div', { className: 'dsh-agy-list' },
              ...groups.map((group, idx) => h('div', { key: `${group.kind || 'g'}-${idx}` }, quotaRow(group, quotaGroupLabel(group)))),
              entitled.length > 0
                ? h('div', { className: 'dsh-agy-quota-note' },
                  t(
                    `Entitled models: ${entitled.map((m) => m.name || m.id).join(' · ')}${disabledList.length > 0 ? ` · Disabled on this plan: ${disabledList.join(', ')}` : ''}`,
                    `端点可用模型：${entitled.map((m) => m.name || m.id).join(' · ')}${disabledList.length > 0 ? `（当前订阅未开放 ${disabledList.join(', ')}）` : ''}`,
                  ))
                : null))
    }

    /**
     * One account card: identity, quota toggle, scheduling controls, and the
     * inline sign-in hand-off. Every value it reads arrives through props — the
     * panel keeps the pending, loading, ticket, and draft state.
     */
    function AccountCard(props) {
      const row = props.row
      const id = row.id
      const system = row.system === true
      const busy = props.busy === true
      const running = (kind) => props.runningKind === kind
      const ticket = props.ticket
      const cooldowns = Array.isArray(row.cooldowns) ? row.cooldowns : []
      const removeStyle = { padding: '4px 10px', color: '#d9534f', borderColor: 'color-mix(in srgb, #d9534f 30%, transparent)' }
      // Removing the machine account drops this Mac's own login from the list,
      // so it asks once inline before the list is submitted. A declared account
      // is removed on the spot, as before.
      const removeControl = system
        ? (props.confirmingRemove === true
          ? h('span', { className: 'dsh-agy-remove-confirm' },
            h(SmallButton, { variant: 'danger', disabled: busy, onClick: () => props.onConfirmRemove(), style: removeStyle }, running('remove') ? '…' : t('Confirm remove', '确认移除')),
            h(SmallButton, { disabled: busy, onClick: () => props.onCancelRemove() }, t('Cancel', '取消')))
          : h(SmallButton, { variant: 'danger', disabled: busy, onClick: () => props.onAskRemove(), style: removeStyle }, t('Remove', '移除')))
        : h(SmallButton, { variant: 'danger', disabled: busy, onClick: () => props.onRemove(), style: removeStyle }, running('remove') ? '…' : t('Remove', '删除'))
      return h('div', {
        className: 'dsh-agy-account-card',
        'data-agy-account': id,
        style: row.enabled === false ? { opacity: 0.68 } : undefined,
      },
        // Main row: avatar + two-line identity on the left, actions in ONE
        // vertically centered cluster on the right (no orphaned sign-in row).
        h('div', { className: 'dsh-agy-account-head' },
          h('div', { className: 'dsh-agy-account-identity' },
            h('span', { className: 'dsh-agy-avatar' }, accountGlyph(system)),
            h('div', { className: 'dsh-agy-account-meta' },
              h('div', { className: 'dsh-agy-account-line' },
                props.editing === true
                  ? h('input', {
                    type: 'text',
                    className: 'dsh-agy-input',
                    value: props.editValue,
                    autoFocus: true,
                    'aria-label': t('Remark', '备注名称'),
                    disabled: busy,
                    onChange: (e) => props.onChangeEditValue(e.target.value ?? ''),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') { e.preventDefault(); props.onCommitRename() }
                      if (e.key === 'Escape') { props.onCancelRename() }
                    },
                    onBlur: () => props.onCommitRename(),
                    style: { fontWeight: 600, flex: '1 1 180px' },
                  })
                  : h('span', {
                    className: 'dsh-agy-account-title',
                    title: t('Click to edit the remark', '点击修改备注'),
                    onClick: () => props.onBeginRename(),
                  }, accountTitle(row)),
                system ? h('span', { className: 'dsh-agy-badge dsh-agy-badge-system' }, t('Default', '默认')) : null,
                tierBadge(row.subscriptionTier || (props.quota && props.quota.subscriptionTier), row.subscriptionName || (props.quota && props.quota.subscriptionName)),
                schedBadge(row)),
              h('div', { className: 'dsh-agy-account-sub' },
                (!system && !remarkOf(row) && signedIn(row))
                  ? null
                  : h('span', { className: 'dsh-agy-account-email' }, row.email || t('Not signed in', '未登录')),
                h('span', { className: 'dsh-agy-account-sessions' }, t(`${Number(row.sessions) || 0} sessions`, `${Number(row.sessions) || 0} 会话`)),
                Array.isArray(row.visibleModels) && row.visibleModels.length > 0
                  ? h('span', {}, t(`Routes ${row.visibleModels.length} models`, `限 ${row.visibleModels.length} 个模型`))
                  : (signedIn(row)
                    ? h('span', {}, t('All global models', '跟随全局模型'))
                    : null)))),
          h('div', { className: 'dsh-agy-account-actions' },
            (system || signedIn(row)) ? h('button', {
              type: 'button',
              className: 'dsh-agy-btn dsh-agy-btn-row',
              'aria-pressed': !!props.quotaOpen,
              disabled: busy,
              onClick: () => props.onToggleQuota(),
            }, t('Quota', '额度'), miniChevron(!!props.quotaOpen)) : null,
            system ? null : h(SmallButton, { className: 'dsh-agy-btn-row', disabled: busy, onClick: () => props.onToggleEnabled() }, running('toggle') ? '…' : row.enabled === false ? t('Enable', '启用') : t('Disable', '停用')),
            signedIn(row)
              ? h(SmallButton, { className: 'dsh-agy-btn-row', disabled: busy, onClick: () => props.onEdit() }, running('save') ? '…' : t('Edit', '编辑'))
              : h(SmallButton, { className: 'dsh-agy-btn-row', disabled: busy, onClick: () => props.onLogin() }, running('login') ? '…' : t('Sign in', '登录')),
            removeControl)),
        props.quotaOpen ? h(AccountQuotaDrawer, {
          row,
          quota: props.quota,
          loading: props.quotaLoading,
          busy,
          onRefresh: () => props.onRefreshQuota(),
        }) : null,
        cooldowns.length > 0 ? h('div', { className: 'dsh-agy-cooldowns' },
          ...cooldowns.map((entry) => h('span', { key: String(entry.family), 'data-agy-cooldown': entry.family },
            t(`${accountFamilyLabel(entry.family)} paused ${cooldownLabel(entry.until)}`, `${accountFamilyLabel(entry.family)} 冷却 ${cooldownLabel(entry.until)}`)))) : null,
        row.error ? h('div', { role: 'alert', className: 'dsh-agy-account-error' }, row.error) : null,
        // Inline sign-in hand-off: authorization link, terminal fallback, and
        // an equal-height code field + primary submit + cancel cluster. Both
        // read-only lines carry their own copy action — each one is a wall of
        // wrapped text that no one should have to drag-select.
        ticket ? h('div', { className: 'dsh-agy-ticket' },
          ticket.url ? h('div', { className: 'dsh-agy-ticket-row', 'data-agy-ticket': 'link' },
            h('a', {
              href: ticket.url,
              target: '_blank',
              rel: 'noreferrer',
              className: 'dsh-agy-ticket-link',
            }, ticket.url),
            h(CopyButton, {
              kind: 'link',
              text: ticket.url,
              label: t('Copy sign-in link', '复制授权链接'),
            })) : null,
          ticket.command ? h('div', { className: 'dsh-agy-ticket-row', 'data-agy-ticket': 'command' },
            h('code', { className: 'dsh-agy-ticket-command' }, ticket.command),
            h(CopyButton, {
              kind: 'command',
              text: ticket.command,
              label: t('Copy terminal command', '复制终端命令'),
            })) : null,
          h('div', { className: 'dsh-agy-inline-row-wrap' },
            h('input', {
              type: 'text',
              className: 'dsh-agy-input',
              value: props.code,
              placeholder: t('Paste authorization code', '粘贴授权码'),
              'aria-label': t('Authorization code', '授权码'),
              disabled: busy,
              onChange: (e) => props.onChangeCode(e.target.value ?? ''),
              style: { flex: '1 1 180px', height: 34, padding: '4px 10px' },
            }),
            h(SmallButton, { variant: 'primary', disabled: busy, onClick: () => props.onSubmitCode(), style: { height: 34, padding: '0 14px' } }, running('code') ? '…' : t('Submit', '提交')),
            h(SmallButton, { disabled: busy, onClick: () => props.onCancelLogin(), style: { height: 34, padding: '0 14px' } }, running('cancel') ? '…' : t('Cancel', '取消')))) : null,
        props.error ? h('div', { role: 'alert', className: 'dsh-agy-row-alert' }, props.error) : null,
        props.notice ? h('div', { role: 'status', className: 'dsh-agy-row-notice' }, props.notice) : null)
    }

    /**
     * Editor dialog of one account: remark, scheduling, proxy, context window,
     * routable models, and this run's token usage. The panel owns the draft, so
     * the dialog is a controlled view with no state of its own. A null `row`
     * renders the same closed Modal the panel used to mount directly.
     */
    function AccountEditorModal(props) {
      const row = props.row
      if (row === null) {
        return h(Modal, { open: false, onClose: props.onClose, title: '' })
      }
      const draft = props.draft
      const busy = props.busy === true
      const running = (kind) => props.runningKind === kind
      const usage = row.usage && typeof row.usage === 'object' ? row.usage : { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      const pVal = clampInt(draft.priority, 1, 999, 1)
      const wVal = clampInt(draft.weight, 1, 100, 1)
      const setDraft = (patch) => props.onDraftChange(patch)

      return h(Modal, {
        open: true,
        onClose: () => { if (!busy) props.onClose() },
        title: t(`Edit account · ${accountTitle(row)}`, `编辑账号 · ${accountTitle(row)}`),
        closeLabel: t('Close', '关闭'),
        className: 'dsh-agy-modal',
        footer: [
          h(SmallButton, {
            key: 'relogin',
            disabled: busy,
            onClick: () => props.onRelogin(),
            className: 'dsh-agy-btn-dialog-start',
          }, t('Sign in again', '重新登录')),
          h(SmallButton, {
            key: 'cancel',
            disabled: busy,
            onClick: () => props.onClose(),
            className: 'dsh-agy-btn-dialog',
          }, t('Cancel', '取消')),
          h(SmallButton, {
            key: 'save',
            variant: 'primary',
            disabled: busy,
            onClick: () => props.onSave(),
            className: 'dsh-agy-btn-dialog',
          }, running('save') ? '…' : t('Save', '保存')),
        ],
      },
      h('div', { className: 'dsh-agy-editor-modal', 'data-agy-editor-modal': row.id },
        h('label', { className: 'dsh-agy-inline-row' },
          h('span', { className: 'dsh-agy-label' }, t('Remark', '备注名称')),
          h('input', {
            type: 'text',
            className: 'dsh-agy-input',
            value: draft.remark,
            'aria-label': t('Account remark', '账号备注'),
            placeholder: signedIn(row) ? row.email : t('Optional display name', '可选，留空默认显示邮箱'),
            disabled: busy,
            onChange: (event) => setDraft({ remark: event.target.value ?? '' }),
            style: { flex: '1 1 200px', height: 34 },
          })),
        h('div', { className: 'dsh-agy-grid2' },
          h('div', { className: 'dsh-agy-stat-box' },
            h('span', { className: 'dsh-agy-stat-label' }, t('Priority', '优先级')),
            h('div', { className: 'dsh-agy-stepper' },
              h('button', {
                type: 'button',
                className: 'dsh-agy-step-btn',
                'aria-label': t('Raise priority', '提高优先级'),
                disabled: busy || pVal <= 1,
                onClick: () => setDraft({ priority: Math.max(1, pVal - 1) }),
              }, '−'),
              h('input', {
                type: 'number',
                min: 1,
                max: 999,
                className: 'dsh-agy-input dsh-agy-number-input',
                'aria-label': t('Priority', '优先级'),
                value: String(draft.priority),
                disabled: busy,
                onChange: (event) => setDraft({ priority: event.target.value === '' ? 1 : clampInt(event.target.value, 1, 999, pVal) }),
              }),
              h('button', {
                type: 'button',
                className: 'dsh-agy-step-btn',
                'aria-label': t('Lower priority', '降低优先级'),
                disabled: busy || pVal >= 999,
                onClick: () => setDraft({ priority: Math.min(999, pVal + 1) }),
              }, '+')),
            h('p', { className: 'dsh-agy-stat-hint' }, t('Smaller runs first (1 > 2)', '数值越小越优先调度（1 优先于 2）'))),
          h('div', { className: 'dsh-agy-stat-box' },
            h('span', { className: 'dsh-agy-stat-label' }, t('Weight', '权重')),
            h('div', { className: 'dsh-agy-stepper' },
              h('button', {
                type: 'button',
                className: 'dsh-agy-step-btn',
                'aria-label': t('Decrease weight', '减小权重'),
                disabled: busy || wVal <= 1,
                onClick: () => setDraft({ weight: Math.max(1, wVal - 1) }),
              }, '−'),
              h('input', {
                type: 'number',
                min: 1,
                max: 100,
                className: 'dsh-agy-input dsh-agy-number-input',
                'aria-label': t('Weight', '权重'),
                value: String(draft.weight),
                disabled: busy,
                onChange: (event) => setDraft({ weight: event.target.value === '' ? 1 : clampInt(event.target.value, 1, 100, wVal) }),
              }),
              h('button', {
                type: 'button',
                className: 'dsh-agy-step-btn',
                'aria-label': t('Increase weight', '增大权重'),
                disabled: busy || wVal >= 100,
                onClick: () => setDraft({ weight: Math.min(100, wVal + 1) }),
              }, '+')),
            h('p', { className: 'dsh-agy-stat-hint' }, t('Load share within same priority', '同优先级下按权重比例分配会话')))),
        h('label', { className: 'dsh-agy-inline-row' },
          h('span', { className: 'dsh-agy-label' }, t('Proxy', '代理')),
          h('input', {
            type: 'text',
            className: 'dsh-agy-input',
            value: draft.proxy,
            'aria-label': t('Proxy', '代理'),
            placeholder: t('http://host:port or socks5://host:port', 'http://主机:端口 或 socks5://主机:端口'),
            disabled: busy,
            onChange: (event) => setDraft({ proxy: event.target.value ?? '' }),
            style: { flex: '1 1 160px', height: 34 },
          })),
        h('div', { className: 'dsh-agy-inline-row-wrap' },
          h('span', { className: 'dsh-agy-label' }, t('Window', '上下文')),
          ...windowOptions().map((option) => h('button', {
            key: String(option.value),
            type: 'button',
            className: 'dsh-agy-btn dsh-agy-btn-row',
            'aria-pressed': draft.contextWindow === option.value,
            disabled: busy,
            onClick: () => setDraft({ contextWindow: option.value }),
            style: { fontWeight: draft.contextWindow === option.value ? 500 : 400 },
          }, option.value === 0 ? t('Follow global default', '跟随全局默认') : option.label))),
        h(MS.ModelSelectionBlock, {
          adapter: antigravityAccountAdapter(props.client, row.id, t('Routable models', '账号调度模型')),
          disabled: busy,
          compact: true,
          draftIds: draft.visibleModels,
          onDraftChange: (nextIds) => setDraft({ visibleModels: nextIds }),
        }),
        h('div', { className: 'dsh-agy-usage' },
          h('span', {}, t(`Input ${tokens(usage.inputTokens)}`, `输入 ${tokens(usage.inputTokens)}`)),
          h('span', {}, t(`Output ${tokens(usage.outputTokens)}`, `输出 ${tokens(usage.outputTokens)}`)),
          h('span', {}, t(`Total ${tokens(usage.totalTokens)} this run`, `本次运行合计 ${tokens(usage.totalTokens)}`))),
        props.error ? h('div', { role: 'alert', className: 'dsh-agy-row-alert' }, props.error) : null))
    }

    /**
     * Account pool panel: one block per configured Antigravity account with its
     * sign-in state, open cooldowns, and live enable switch, plus the
     * interactive sign-in hand-off (authorization URL, terminal fallback, and
     * the code the browser shows).
     *
     * The Host replaces the whole account list instead of patching one entry,
     * so every mutation rebuilds the complete profile list from the rows the
     * status reported — this Mac's own `system: true` row included. `home` and
     * `env` do not travel in `AccountStatus` in full: an empty `home` keeps the
     * directory under the plugin home and an empty `env` adds no variables. The
     * machine row is always enabled, so it carries no switch, but its remark is
     * editable and dropping it from the list is how the user stops using this
     * Mac's own login.
     *
     * The panel owns every piece of state; its cards, quota drawer, and editor
     * dialog are controlled views that read props and report one callback.
     */
    function AccountsPanel(props) {
      // A status without an account list means "not loaded yet", never "no
      // accounts": every action waits and says so instead of saving an empty
      // list over this Mac's own login.
      const listLoaded = accountsLoaded(props.accounts)
      const rows = Array.isArray(props.accounts) ? props.accounts : []
      const [draftRemark, setDraftRemark] = React.useState('')
      const [draftError, setDraftError] = React.useState(null)
      const [pending, setPending] = React.useState(null)
      const [panelError, setPanelError] = React.useState(null)
      const [tickets, setTickets] = React.useState({})
      const [codes, setCodes] = React.useState({})
      const [rowErrors, setRowErrors] = React.useState({})
      const [rowNotices, setRowNotices] = React.useState({})
      const [editingId, setEditingId] = React.useState(null)
      const [editValue, setEditValue] = React.useState('')
      const [editorId, setEditorId] = React.useState(null)
      const [drafts, setDrafts] = React.useState({})
      const [quotas, setQuotas] = React.useState({})
      const [openQuotas, setOpenQuotas] = React.useState({})
      const [quotaLoading, setQuotaLoading] = React.useState({})
      // The machine row asks for a second click before its login leaves the list.
      const [confirmRemoveId, setConfirmRemoveId] = React.useState(null)
      const editingRef = React.useRef(null)

      const busyId = pending === null ? null : pending.id
      const busy = busyId !== null
      const running = (id, kind) => busyId === id && pending.kind === kind
      const remember = (setter, id, value) => setter((prev) => ({ ...prev, [id]: value }))
      const messageOf = (error) => (error instanceof Error ? error.message : String(error))

      /**
       * Every profile rebuilt from the status rows, machine row included: the
       * account list is the whole truth, so a save that dropped this Mac's own
       * entry would silently delete its login. `home` and `env` are carried
       * through verbatim so toggling one account never rewrites another
       * account's root or proxy binding, and the machine row keeps `system`.
       */
      const profiles = () => rows
        .filter((row) => row !== null && typeof row === 'object')
        .map((row) => ({
          id: row.id,
          displayName: storedDisplayName(row),
          home: typeof row.home === 'string' ? row.home : '',
          enabled: row.system === true ? true : row.enabled !== false,
          env: row.env !== null && typeof row.env === 'object' && !Array.isArray(row.env) ? { ...row.env } : {},
          contextWindow: Number(row.contextWindow) || 0,
          ...row.system === true ? { system: true } : {},
          visibleModels: Array.isArray(row.visibleModels) ? row.visibleModels.filter((entry) => typeof entry === 'string') : [],
          priority: clampInt(row.priority, 1, 999, 1),
          weight: clampInt(row.weight, 1, 100, 1),
        }))

      /** Replace the declared list and adopt the status the Host reports back. */
      const apply = async (id, kind, accounts) => {
        if (!accountsLoaded(props.accounts)) {
          setPanelError(messageOf(accountsNotLoaded()))
          return false
        }
        setPending({ id, kind })
        setPanelError(null)
        try {
          const status = await props.client.configure({ accounts })
          if (typeof props.onStatus === 'function') props.onStatus(status)
          return true
        } catch (error) {
          setPanelError(messageOf(error))
          return false
        } finally {
          setPending(null)
        }
      }

      const toggleRow = (row) => {
        const next = profiles().map((profile) => profile.id === row.id ? { ...profile, enabled: row.enabled !== true } : profile)
        void apply(row.id, 'toggle', next)
      }

      const removeRow = (row) => {
        setConfirmRemoveId(null)
        void apply(row.id, 'remove', profiles().filter((profile) => profile.id !== row.id))
      }

      const askRemove = (row) => {
        if (busy) return
        remember(setRowErrors, row.id, null)
        setConfirmRemoveId(row.id)
      }

      const addSystemRow = () => {
        setDraftError(null)
        void apply(USE_SYSTEM_PENDING, 'add-system', [
          {
            id: SYSTEM_ACCOUNT_ID,
            system: true,
            displayName: '',
            home: '',
            enabled: true,
            env: {},
            contextWindow: 0,
            visibleModels: [],
            priority: 1,
            weight: 1,
          },
          ...profiles(),
        ])
      }

      const beginRename = (row) => {
        if (busy) return
        editingRef.current = row.id
        setEditingId(row.id)
        setEditValue(storedDisplayName(row))
      }

      const cancelRename = () => {
        editingRef.current = null
        setEditingId(null)
      }

      const commitRename = (row) => {
        if (editingRef.current !== row.id) return
        editingRef.current = null
        setEditingId(null)
        const remark = cleanRemark(editValue)
        if ([...remark].length > REMARK_LIMIT) {
          remember(setRowErrors, row.id, t('Use at most 64 characters', '备注最多 64 个字符'))
          return
        }
        remember(setRowErrors, row.id, null)
        if (remark === storedDisplayName(row)) return
        const displayName = row.system === true && remark === SYSTEM_ACCOUNT_LABEL ? '' : remark
        const next = profiles().map((profile) => profile.id === row.id ? { ...profile, displayName } : profile)
        void apply(row.id, 'rename', next)
      }

      const addRow = () => {
        const remark = cleanRemark(draftRemark)
        if ([...remark].length > REMARK_LIMIT) {
          setDraftError(t('Use at most 64 characters', '备注最多 64 个字符'))
          return
        }
        const id = freshAccountId(rows)
        setDraftError(null)
        void apply(ADD_PENDING, 'add', [...profiles(), { id, displayName: remark, home: '', enabled: true, env: {} }])
          .then((done) => { if (done) setDraftRemark('') })
      }

      const beginLogin = async (row) => {
        setPending({ id: row.id, kind: 'login' })
        remember(setRowErrors, row.id, null)
        remember(setRowNotices, row.id, null)
        try {
          const ticket = await props.client.login({ accountId: row.id })
          remember(setTickets, row.id, { url: ticket.url, command: ticket.command })
        } catch (error) {
          remember(setRowErrors, row.id, messageOf(error))
        } finally {
          setPending(null)
        }
      }

      const submitCode = async (row) => {
        const code = (codes[row.id] || '').trim()
        if (code.length === 0) {
          remember(setRowErrors, row.id, t('Paste the authorization code first', '请先粘贴授权码'))
          return
        }
        setPending({ id: row.id, kind: 'code' })
        remember(setRowErrors, row.id, null)
        remember(setRowNotices, row.id, null)
        try {
          const result = await props.client.loginCode({ accountId: row.id, code })
          if (result !== null && typeof result === 'object' && result.ok === true) {
            remember(setTickets, row.id, null)
            remember(setCodes, row.id, '')
            remember(setRowNotices, row.id, result.email ? t(`Signed in as ${result.email}`, `已登录 ${result.email}`) : t('Signed in', '已登录'))
            const status = await props.client.status()
            if (typeof props.onStatus === 'function') props.onStatus(status)
          } else {
            remember(setRowErrors, row.id, (result && result.error) || t('The sign-in did not finish', '登录未完成'))
          }
        } catch (error) {
          remember(setRowErrors, row.id, messageOf(error))
        } finally {
          setPending(null)
        }
      }

      const cancelLogin = async (row) => {
        setPending({ id: row.id, kind: 'cancel' })
        remember(setRowErrors, row.id, null)
        try {
          const status = await props.client.cancelLogin({ accountId: row.id })
          remember(setTickets, row.id, null)
          remember(setCodes, row.id, '')
          if (typeof props.onStatus === 'function' && status !== null && typeof status === 'object') props.onStatus(status)
        } catch (error) {
          remember(setRowErrors, row.id, messageOf(error))
        } finally {
          setPending(null)
        }
      }

      const draftFor = (row) => drafts[row.id] || baseDraft(row)
      const setDraft = (id, patch) => setDrafts((prev) => {
        const row = rows.find((item) => item.id === id) || { id, label: '', env: {}, visibleModels: [], contextWindow: 0, priority: 1, weight: 1 }
        const base = prev[id] || baseDraft(row)
        return { ...prev, [id]: { ...base, ...patch } }
      })

      const loadAccountQuota = (row, force) => {
        remember(setQuotaLoading, row.id, true)
        props.client.quota({ accountId: row.id, force: force === true }).then((snapshot) => {
          setQuotas((prev) => ({ ...prev, [row.id]: snapshot }))
          if (snapshot && snapshot.status === 'ok' && (snapshot.subscriptionTier || snapshot.availableModels)) {
            props.client.status().then((next) => {
              if (typeof props.onStatus === 'function') props.onStatus(next)
            }).catch(() => undefined)
          }
        }).catch((error) => {
          setQuotas((prev) => ({ ...prev, [row.id]: { status: 'error', groups: [], error: messageOf(error) } }))
        }).finally(() => {
          remember(setQuotaLoading, row.id, false)
        })
      }

      const toggleAccountQuota = (row) => {
        const nextOpen = !openQuotas[row.id]
        remember(setOpenQuotas, row.id, nextOpen)
        if (nextOpen && quotas[row.id] === undefined) {
          loadAccountQuota(row, false)
        }
      }

      const openEditor = (row) => {
        remember(setRowErrors, row.id, null)
        setEditorId(row.id)
        setDrafts((prev) => ({ ...prev, [row.id]: baseDraft(row) }))
      }

      const closeEditor = () => setEditorId(null)

      const saveEditor = async (row) => {
        const draft = draftFor(row)
        const remark = cleanRemark(draft.remark)
        if ([...remark].length > REMARK_LIMIT) {
          remember(setRowErrors, row.id, t(`Keep the remark under ${REMARK_LIMIT} characters`, `备注名称最多 ${REMARK_LIMIT} 个字符`))
          return
        }
        let env
        try {
          env = envWithProxy(row.env, draft.proxy)
        } catch (error) {
          remember(setRowErrors, row.id, messageOf(error))
          return
        }
        const contextWindow = Number(draft.contextWindow) || 0
        const priority = clampInt(draft.priority, 1, 999, 1)
        const weight = clampInt(draft.weight, 1, 100, 1)
        const visibleModels = Array.isArray(draft.visibleModels) ? [...draft.visibleModels] : []
        remember(setRowErrors, row.id, null)
        // The machine row is one entry of the same list: its edit and a
        // declared account's edit both travel through `accounts`, so saving
        // never splits the list across two wire fields.
        const displayName = row.system === true && remark === SYSTEM_ACCOUNT_LABEL ? '' : remark
        const next = profiles().map((profile) => profile.id === row.id ? { ...profile, displayName, env, contextWindow, visibleModels, priority, weight } : profile)
        const saved = await apply(row.id, 'save', next)
        if (saved) setEditorId(null)
      }

      // Hydrate keychain emails on mount and auto-detect external terminal sign-ins while any ticket is open.
      const openTicketIds = Object.keys(tickets).filter((key) => tickets[key] !== null && tickets[key] !== undefined).join(',')
      React.useEffect(() => {
        if (!listLoaded) return undefined
        if (typeof props.client.accounts !== 'function') return undefined
        let live = true
        const syncEmails = async () => {
          try {
            const freshAccounts = await props.client.accounts()
            if (!live || !Array.isArray(freshAccounts)) return
            let completedEmail = null
            let completedId = null
            for (const item of freshAccounts) {
              if (item && tickets[item.id] && typeof item.email === 'string' && item.email.length > 0) {
                completedId = item.id
                completedEmail = item.email
              }
            }
            if (completedId !== null) {
              remember(setTickets, completedId, null)
              remember(setCodes, completedId, '')
              remember(setRowNotices, completedId, t(`Signed in as ${completedEmail}`, `已登录 ${completedEmail}`))
            }
            const status = await props.client.status()
            if (live && typeof props.onStatus === 'function') props.onStatus(status)
          } catch { /* ignore transient poll errors */ }
        }
        void syncEmails()
        if (openTicketIds.length === 0) return () => { live = false }
        const handle = setInterval(() => { void syncEmails() }, 2500)
        if (typeof handle?.unref === 'function') handle.unref()
        return () => {
          live = false
          clearInterval(handle)
        }
      }, [openTicketIds, listLoaded])

      const activeEditorRow = editorId === null ? null : (rows.filter((entry) => entry && entry.id === editorId)[0] || null)
      const hasSystem = rows.some((entry) => entry !== null && typeof entry === 'object' && entry.system === true)
      const shownError = listLoaded ? panelError : messageOf(accountsNotLoaded())

      return h('div', { className: 'dsh-agy-accounts' },
        h('div', { className: 'dsh-agy-accounts-head' },
          h('span', { className: 'dsh-agy-accounts-title' }, t('Accounts', '账号')),
          h('span', { className: 'dsh-agy-count' }, listLoaded ? t(`${rows.length} configured`, `共 ${rows.length} 个`) : '—')),
        h('div', { className: 'dsh-agy-account-list' }, ...rows.map((row) => h(AccountCard, {
          key: row.id,
          row,
          busy,
          runningKind: busyId === row.id ? pending.kind : null,
          editing: editingId === row.id,
          editValue,
          quotaOpen: !!openQuotas[row.id],
          quota: quotas[row.id],
          quotaLoading: !!quotaLoading[row.id],
          ticket: tickets[row.id],
          code: codes[row.id] || '',
          error: editorId === row.id ? null : (rowErrors[row.id] || null),
          notice: rowNotices[row.id] || null,
          onToggleQuota: () => toggleAccountQuota(row),
          onRefreshQuota: () => loadAccountQuota(row, true),
          onToggleEnabled: () => toggleRow(row),
          onRemove: () => removeRow(row),
          confirmingRemove: confirmRemoveId === row.id,
          onAskRemove: () => askRemove(row),
          onConfirmRemove: () => removeRow(row),
          onCancelRemove: () => setConfirmRemoveId(null),
          onEdit: () => openEditor(row),
          onLogin: () => void beginLogin(row),
          onSubmitCode: () => void submitCode(row),
          onCancelLogin: () => void cancelLogin(row),
          onChangeCode: (value) => remember(setCodes, row.id, value),
          onBeginRename: () => beginRename(row),
          onCommitRename: () => commitRename(row),
          onCancelRename: () => cancelRename(),
          onChangeEditValue: (value) => setEditValue(value),
        }))),
        // Input and button are pixel-level equal height (34px each).
        h('div', { className: 'dsh-agy-inline-row' },
          h('input', {
            type: 'text',
            className: 'dsh-agy-input',
            value: draftRemark,
            placeholder: t('Remark (optional)', '备注名称（可选）'),
            'aria-label': t('Remark (optional)', '备注名称（可选）'),
            disabled: busy || !listLoaded,
            onChange: (e) => { setDraftRemark(e.target.value ?? ''); setDraftError(null) },
            onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addRow() } },
            style: { flex: '1 1 140px', height: 34 },
          }),
          h(SmallButton, { variant: 'primary', disabled: busy || !listLoaded, onClick: addRow, style: { height: 34, padding: '0 14px' } }, running(ADD_PENDING, 'add') ? '…' : t('Add account', '添加账号')),
          listLoaded && !hasSystem ? h(SmallButton, { disabled: busy, onClick: addSystemRow, style: { height: 34, padding: '0 14px' } }, running(USE_SYSTEM_PENDING, 'add-system') ? '…' : t("Use this Mac's login", '使用本机登录')) : null),
        draftError ? h('div', { role: 'alert', className: 'dsh-agy-error-text' }, draftError) : null,
        shownError ? h('div', { role: 'alert', className: 'dsh-agy-error-text' }, shownError) : null,
        h(AccountEditorModal, {
          row: activeEditorRow,
          draft: activeEditorRow === null ? null : draftFor(activeEditorRow),
          busy,
          runningKind: activeEditorRow !== null && busyId === activeEditorRow.id ? pending.kind : null,
          client: props.client,
          error: activeEditorRow === null ? null : (rowErrors[activeEditorRow.id] || null),
          onClose: closeEditor,
          onSave: () => { void saveEditor(activeEditorRow) },
          onRelogin: () => { setEditorId(null); void beginLogin(activeEditorRow) },
          onDraftChange: (patch) => setDraft(activeEditorRow.id, patch),
        }))
    }


    const degradeSignalLabel = (sig) => {
      if (!sig || typeof sig !== 'object') return ''
      // Every label states what the user saw and what it means, never the
      // internal metric that produced it. `detail` supplies the only number
      // worth showing; when it cannot be read, it is shown as-is.
      const detail = typeof sig.detail === 'string' ? sig.detail.trim() : ''
      if (sig.kind === 'context_truncated') {
        // `detail` is `342K→128K`; the left side is the context size before the cut.
        const arrow = detail.indexOf('→')
        const was = arrow > 0 ? detail.slice(0, arrow).trim() : detail
        return was
          ? t(`Context cut to 128K (was ${was})`, `上下文被截到 128K（原 ${was}）`)
          : t('Context cut to 128K', '上下文被截到 128K')
      }
      if (sig.kind === 'cache_cliff') {
        // `detail` is `-20.7K`; the amount is what the session lost.
        const amount = detail.replace(/^-\s*/, '')
        return amount
          ? t(`Context shrank by ${amount}`, `上下文少了 ${amount}`)
          : t('Context shrank', '上下文少了')
      }
      if (sig.kind === 'fast_decode') {
        return detail
          ? t(`Decoding too fast ${detail}`, `输出过快 ${detail}`)
          : t('Decoding too fast', '输出过快')
      }
      if (sig.kind === 'block_cache') {
        return t('Cache aligned to 2048-token blocks', '缓存按 2048 块对齐')
      }
      if (sig.kind === 'shallow_thought') {
        if (sig.thoughtTokens === 0) return t('No thinking', '没有思考')
        return detail
          ? t(`Thinking too short (first token at ${detail})`, `思考过短（${detail} 出字）`)
          : t('Thinking too short', '思考过短')
      }
      return String(sig.detail || '')
    }

    function QuotaPill(props) {
      const state = useStore(props.store)
      const selection = state && state.current
      const active = !!selection && selection.provider === PROVIDER
      const rootRef = React.useRef(null)
      const [quota, setQuota] = React.useState(null)
      const [runtimeStatus, setRuntimeStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)

      // The model on screen, read through a ref so a refresh always asks about
      // the current selection, and a sequence counter so an answer that arrives
      // after a switch is dropped instead of painted over the new model.
      const modelRef = React.useRef(undefined)
      modelRef.current = selection && selection.model
      const seqRef = React.useRef(0)

      const syncStatus = React.useCallback(() => {
        if (typeof props.client.statusNow !== 'function') return
        props.client.statusNow().then((s) => {
          if (s && typeof s === 'object') setRuntimeStatus(s)
        }).catch(() => undefined)
      }, [props.client])

      const refresh = React.useCallback(async (force) => {
        const model = modelRef.current
        const seq = ++seqRef.current
        setBusy(true)
        syncStatus()
        try {
          // Ask by model, not by "whatever ran last": the host resolves the
          // account that actually serves this model and reads its own windows.
          const q = await props.client.quota({ model, force: force === true, sessionId: props.sessionId || undefined })
          if (seq !== seqRef.current || model !== modelRef.current) return
          // The host echoes the model it resolved; an answer for another model
          // stays stale even when it is the newest response to arrive.
          if (q && typeof q === 'object' && typeof q.model === 'string' && q.model !== model) return
          setQuota(q && typeof q === 'object' ? q : null)
          setError(q && q.status === 'error' ? q.error || null : null)
        } catch (e) {
          if (seq !== seqRef.current || model !== modelRef.current) return
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          if (seq === seqRef.current) setBusy(false)
        }
      }, [props.client, syncStatus])

      React.useEffect(() => {
        if (!active) { setOpen(false); return undefined }
        // A switch invalidates the previous model's windows immediately, so no
        // other account's number can stand in for the new model while the read
        // is in flight.
        setQuota(null)
        setError(null)
        void refresh(false)
        const quotaTimer = setInterval(() => { void refresh(false) }, 180_000)
        return () => {
          clearInterval(quotaTimer)
        }
      }, [active, selection && selection.model, refresh])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (e) => {
          const root = rootRef.current
          if (!root) return
          const inside = typeof root.contains === 'function' ? root.contains(e.target) : root === e.target
          if (!inside) setOpen(false)
        }
        const onKeyDown = (e) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      if (!active) return null
      // Route health covers both Gemini 4 flagship families (Argon and Carbon).
      const isFlagship = /argon|carbon/i.test(String((selection && selection.model) || ''))
      const healthMap = runtimeStatus && runtimeStatus.sessionHealth && typeof runtimeStatus.sessionHealth === 'object'
        ? runtimeStatus.sessionHealth
        : null
      const sessionHealth = isFlagship && props.sessionId && healthMap ? healthMap[props.sessionId] || null : null
      const isDegraded = !!(sessionHealth && sessionHealth.degraded === true)
      const interceptedCount = sessionHealth && Number(sessionHealth.interceptedSteps) > 0
        ? Number(sessionHealth.interceptedSteps)
        : 0

      // Windows that govern the model on screen. `null` means the payload
      // answers a different model and must not be shown at all; an unentitled
      // view means this account cannot spend the model, so no other family's
      // windows may be substituted for it.
      const view = quota ? quotaViewFor(quota, selection.model) : null
      const group = view && view.entitled ? view.group : undefined
      const family = familyName(group, view && view.family)
      // An empty group list is "not read yet", not "not offered": only a payload
      // that reports windows but none for this family proves the account cannot
      // spend the model.
      const unknown = !!(quota && view && view.entitled === false
        && view.reason === 'no-groups'
        && (!Array.isArray(quota.groups) || quota.groups.length === 0))
      const unavailable = !!(quota && view && view.entitled === false && !unknown)
      const modelFamily = quotaFamilyOf(selection.model)
      const familyShort = modelFamily === 'claude' ? 'Claude' : modelFamily === 'argon' ? 'Argon' : 'Gemini'
      const accountText = quota && (quota.accountLabel || quota.accountId)
        ? String(quota.accountLabel || quota.accountId)
        : ''
      const planText = quota && (quota.subscriptionName || quota.subscriptionTier)
        ? String(quota.subscriptionName || quota.subscriptionTier)
        : ''
      const attribution = [accountText, planText].filter(Boolean).join(' · ')
      const rawBuckets = group ? group.buckets : []
      const buckets = sortBuckets(rawBuckets)
      const primary = rawBuckets.find(isWeeklyBucket) || rawBuckets[0]
      const short = buckets.find((b) => isShortBucket(b) && !bucketPaused(b))
      const secondary = primary ? buckets.filter((b) => b !== primary) : []
      const pillPrefix = !primary ? (unavailable ? familyShort : t('Wk', '周')) : (isWeeklyBucket(primary) ? t('Wk', '周') : windowLabel(primary))
      const pillValue = primary ? pct(primary.remainingFraction) : unavailable ? t('n/a', '未开通') : error ? '!' : '…'
      const baseTooltip = unavailable
        ? `${family}${t(' is not included in this account', ' 未包含在当前账号的订阅中')}${attribution ? ` · ${attribution}` : ''}`
        : pillTitle(primary, short, error, family)
      // Name the account behind the number: two signed-in plans must never look
      // like one shared quota.
      const tooltipBase = !unavailable && primary && attribution.length > 0
        ? `${baseTooltip} · ${attribution}`
        : baseTooltip
      const tooltip = isDegraded
        ? `${tooltipBase}${t(' · May be degraded', ' · 可能降智')}`
        : tooltipBase

      return h('span', { ref: rootRef, className: 'antigravity-quota-pill', style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h('button', {
          type: 'button',
          title: tooltip,
          'aria-label': tooltip,
          'aria-expanded': open,
          'data-agy-quota-model': selection.model || '',
          'data-agy-quota-account': accountText,
          'data-agy-quota-plan': planText,
          'data-agy-quota-entitled': unavailable ? 'false' : primary ? 'true' : 'pending',
          onClick: () => { setOpen(!open); if (!open) void refresh(false) },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '2px 7px',
            border: 'none',
            borderRadius: 999,
            background: open ? 'color-mix(in srgb, currentColor 8%, transparent)' : 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            whiteSpace: 'nowrap',
            opacity: open ? 0.92 : (isDegraded ? 0.96 : 0.8),
            cursor: 'pointer',
          },
        },
          primary ? bar(primary.remainingFraction, 24, 4) : null,
          h('span', { style: { display: 'inline-flex', alignItems: 'baseline', gap: 3, fontVariantNumeric: 'tabular-nums' } },
            h('span', { style: { opacity: 0.72, fontSize: 11 } }, pillPrefix),
            ' ',
            h('span', {
              style: {
                fontWeight: 500,
                color: !primary && error ? '#d9534f' : 'inherit',
                opacity: unavailable ? 0.66 : 1,
              },
            }, pillValue)),
          isDegraded ? h('span', {
            className: 'dsh-agy-degrade-pill',
            'data-agy-degraded': 'true',
          },
            h('span', { className: 'dsh-agy-degrade-dot', 'aria-hidden': 'true' }),
            t('Degraded', '降智')) : null),
        open ? h('div', {
          role: 'dialog',
          'aria-label': t('Quota', '额度'),
          style: {
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            right: 0,
            zIndex: 50,
            boxSizing: 'border-box',
            width: 'max-content',
            minWidth: 248,
            maxWidth: 'min(320px, calc(100vw - 24px))',
            padding: '12px 14px',
            borderRadius: 12,
            background: 'var(--dsw-alias-surface-overlay, var(--dsw-alias-bg-overlay, var(--dsw-specific-menu, Canvas)))',
            backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(20px) saturate(140%))',
            WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter, blur(20px) saturate(140%))',
            color: 'var(--dsw-alias-label-primary, CanvasText)',
            boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,.18))',
            border: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: 'nowrap',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: primary ? 9 : 6 } },
            h('span', { style: { fontWeight: 600, fontSize: 12 } }, t('Quota', '额度')),
            h('button', {
              type: 'button',
              disabled: busy,
              title: t('Refresh', '刷新'),
              onClick: () => void refresh(true),
              style: {
                border: 'none',
                borderRadius: 5,
                background: 'color-mix(in srgb, currentColor 6%, transparent)',
                color: 'inherit',
                opacity: busy ? 0.45 : 0.78,
                font: 'inherit',
                fontSize: 11,
                lineHeight: '18px',
                padding: '1px 7px',
                cursor: busy ? 'default' : 'pointer',
              },
            }, busy ? '…' : t('Refresh', '刷新'))),
          unavailable
            ? h('div', {
              'data-agy-quota-unavailable': familyShort,
              style: { opacity: 0.8, whiteSpace: 'normal', padding: '2px 1px' },
            },
              t(`${family} is not included in this account${planText ? ` (${planText})` : ''}`, `${family} 未包含在此账号的订阅中${planText ? `（${planText}）` : ''}`),
              h('div', { style: { marginTop: 4, opacity: 0.72 } },
                t('Switch to an account that offers it, or pick another model.', '请切换到有该权限的账号，或改选其他模型。')))
            : !primary ? h('div', { style: { opacity: 0.68, whiteSpace: 'normal' } }, error || t('Loading…', '读取中…')) : null,
          primary ? h('div', {
            key: primary.id || 'primary',
            'data-bucket-window': primary.window || primary.id,
            'data-bucket-role': 'primary',
            style: {
              padding: '9px 10px',
              borderRadius: 8,
              background: 'color-mix(in srgb, currentColor 5%, transparent)',
              border: '1px solid color-mix(in srgb, currentColor 8%, transparent)',
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 } },
              h('span', { style: { fontWeight: 500, opacity: 0.86 } }, isWeeklyBucket(primary) ? t('Weekly quota', '每周额度') : windowLabel(primary)),
              h('span', { style: { opacity: 0.58, fontSize: 11, fontVariantNumeric: 'tabular-nums' } }, resetPhrase(primary.resetTime))),
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, margin: '3px 0 7px' } },
              h('span', {
                style: {
                  fontSize: 20,
                  fontWeight: 650,
                  lineHeight: 1.15,
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '-0.02em',
                  color: primary.remainingFraction < 0.15 ? '#d9534f' : 'inherit',
                },
              }, pct(primary.remainingFraction)),
              h('span', { style: { fontSize: 11, opacity: 0.55 } }, t('remaining', '剩余'))),
            bar(primary.remainingFraction, '100%', 6)) : null,
          secondary.length > 0 ? h('div', {
            style: {
              marginTop: 9,
              paddingTop: 8,
              borderTop: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            },
          }, ...secondary.map((b) => {
            const paused = bucketPaused(b)
            return h('div', {
              key: b.id,
              'data-bucket-window': b.window || b.id,
              'data-bucket-role': 'secondary',
              ...(paused ? { 'data-bucket-disabled': 'true' } : {}),
              style: {
                display: 'grid',
                gridTemplateColumns: 'minmax(44px, auto) 44px 36px minmax(0, 1fr)',
                alignItems: 'center',
                gap: 8,
                lineHeight: '18px',
              },
            },
              h('span', { style: { opacity: 0.76 } }, windowLabel(b)),
              paused ? h('span') : bar(b.remainingFraction, 44, 4),
              h('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 500, textAlign: 'right' } }, paused ? t('n/a', '不适用') : pct(b.remainingFraction)),
              h('span', { style: { opacity: 0.55, textAlign: 'right', fontSize: 11, fontVariantNumeric: 'tabular-nums' } }, paused ? '' : resetLabel(b.resetTime)))
          })) : null,
          attribution ? h('div', {
            className: 'dsh-agy-quota-attr',
            'data-agy-quota-account': accountText,
            'data-agy-quota-plan': planText,
            style: {
              marginTop: 9,
              paddingTop: 8,
              borderTop: '1px solid color-mix(in srgb, currentColor 10%, transparent)',
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
              fontSize: 11,
              whiteSpace: 'normal',
            },
          },
            h('span', { style: { opacity: 0.62 } }, t('Account', '账号')),
            h('span', { style: { fontWeight: 500, opacity: 0.9 } }, accountText || attribution),
            planText ? h('span', { style: { opacity: 0.62 } }, `· ${planText}`) : null) : null,
          isDegraded ? h('div', {
            className: 'dsh-agy-degrade-card',
            'data-agy-degrade-card': 'true',
          },
            h('div', { className: 'dsh-agy-degrade-head' },
              h('span', { className: 'dsh-agy-degrade-title' },
                h('span', { className: 'dsh-agy-degrade-dot', 'aria-hidden': 'true' }),
                t('This answer may be degraded', '这条回答可能降智了'))),
            Array.isArray(sessionHealth.signals) && sessionHealth.signals.length > 0
              ? h('div', { className: 'dsh-agy-degrade-tags' },
                ...sessionHealth.signals.map((sig, idx) => h('span', {
                  key: `${sig.kind || 'sig'}-${idx}`,
                  className: 'dsh-agy-degrade-tag',
                  'data-agy-signal': sig.kind,
                }, degradeSignalLabel(sig))))
              : null)
            : interceptedCount > 0
              ? h('div', { className: 'dsh-agy-healed-note', 'data-agy-gatekeeper-healed': String(interceptedCount) },
                t(
                  `Auto-regenerated ${interceptedCount} time(s) in this session`,
                  `本会话已自动重答 ${interceptedCount} 次`,
                ))
              : null,
          primary && error ? h('div', { role: 'status', style: { marginTop: 8, color: '#d9534f', fontSize: 11, whiteSpace: 'normal', opacity: 0.9 } }, error) : null)
          : null)
    }

    const EFFORT_OPTIONS = [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ]

    /** Context-window choices, shared by the Settings row and the menu row. */
    const windowOptions = () => [
      { value: 0, label: t('Auto (1M)', '自动 (1M)') },
      { value: 900000, label: '900K' },
      { value: 512000, label: '512K' },
      { value: 256000, label: '256K' },
    ]

    /** Route-health intervention levels for Gemini 4 Argon / Carbon steps the fingerprint flags. */
    const degradeOptions = () => [
      { value: 'truncation', label: t('Re-answer on 128K truncation', '128K截断重答') },
      { value: 'legacy', label: t('Re-answer on any flag', '全量降智拦截重答') },
      { value: 'observe', label: t('Observe only', '仅监测提示') },
    ]

    /** ACP agent engine modes: DSH tool bridge vs native Antigravity agent with non-overlapping MCP tools. */
    const engineOptions = () => [
      { value: 'bridge', label: t('DSH tool bridge', 'DSH 工具桥接') },
      { value: 'native', label: t('Native agent (full strength)', '原生 Agent（满血）') },
    ]

    /** Long-decode choices: Antigravity's control over how far one reply may run. */
    const decodeOptions = () => [
      { value: 0, label: t('Off', '关闭') },
      { value: 3, label: t('3x', '3 段') },
      { value: 8, label: t('8x', '8 段') },
    ]

    // Live settings last reported by the Host, mirrored into localStorage: the
    // menu rows mount before any round-trip finishes, and a slow or failed
    // status call must not leave the rows blank.
    const SETTINGS_STORAGE_KEY = 'dsh.antigravity.settings.v1'
    const readStoredSettings = () => {
      try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SETTINGS_STORAGE_KEY)
        const parsed = raw === null ? null : JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
      } catch { return null }
    }
    const stored = readStoredSettings()
    let cachedSettings = stored === null ? null : {
      configuredContextWindow: Number(stored.configuredContextWindow) || 0,
      longDecodeContinuations: Number.isFinite(stored.longDecodeContinuations) ? stored.longDecodeContinuations : 3,
    }
    /** Remember the settings-bearing half of a status snapshot. */
    const rememberSettings = (status) => {
      if (!status || typeof status !== 'object') return
      cachedSettings = {
        ...cachedSettings,
        ...(Number.isFinite(status.configuredContextWindow) ? { configuredContextWindow: status.configuredContextWindow } : {}),
        ...(Number.isFinite(status.longDecodeContinuations) ? { longDecodeContinuations: status.longDecodeContinuations } : {}),
      }
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(cachedSettings))
      } catch { /* storage may be unavailable; the in-memory copy still serves */ }
    }

    /** Presentation-only aliases; the canonical model ids remain visible. */
    function DisplayAliases(props) {
      const [editing, setEditing] = React.useState(false)
      const [providerName, setProviderName] = React.useState('')
      const [names, setNames] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const saving = React.useRef(false)
      const begin = () => {
        setProviderName(props.status.displayName || 'Antigravity')
        setNames({ ...(props.status.modelDisplayNames || {}) })
        setError(null)
        setEditing(true)
      }
      const models = props.status.availableModels || props.status.models || []
      const ids = models.map((model) => model.id)
      const rows = models.concat(Object.keys(names).filter((id) => ids.indexOf(id) < 0).map((id) => ({ id, name: id })))
      const save = async () => {
        if (saving.current) return
        saving.current = true
        setBusy(true)
        setError(null)
        try {
          const status = await props.client.configure({ displayName: providerName, modelDisplayNames: names })
          props.onStatus(status)
          setEditing(false)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          saving.current = false
          setBusy(false)
        }
      }
      return h('div', { className: 'dsh-agy-card', style: { padding: 14 } },
        h('div', { className: 'dsh-agy-stack', style: { justifyContent: 'space-between' } },
          h('strong', null, t('Display aliases', '显示别名')),
          !editing ? h('button', { type: 'button', className: 'dsh-agy-btn', onClick: begin }, t('Edit aliases', '编辑别名')) : null),
        editing ? h('fieldset', { disabled: busy, style: { border: 0, padding: 0, margin: '12px 0 0', minWidth: 0 } },
          h('p', { className: 'dsh-agy-muted', style: { margin: '0 0 12px' } }, t('Only display names change. Routing and quota still use the original ids. Clear an alias to restore its default name.', '仅修改显示名称，调用与额度仍使用原始 ID；清空别名可恢复默认名称。')),
          h('label', { style: { display: 'grid', gap: 6 } }, t('Provider alias', '分组别名'),
            h('input', { 'aria-label': t('Provider alias', '分组别名'), maxLength: 80, value: providerName, placeholder: 'Antigravity', onChange: (e) => setProviderName(e.target.value) })),
          h('div', { style: { display: 'grid', gap: 12, maxHeight: 320, overflowY: 'auto', margin: '12px 0' } }, rows.map((model) =>
            h('label', { key: model.id, style: { display: 'grid', gap: 6, minWidth: 0 } },
              h('code', { style: { overflowWrap: 'anywhere' } }, model.id),
              h('input', { 'aria-label': `${t('Model alias', '模型别名')} ${model.id}`, maxLength: 80,
                value: Object.prototype.hasOwnProperty.call(names, model.id) ? names[model.id] : '', placeholder: model.name || model.id,
                onChange: (e) => setNames({ ...names, [model.id]: e.target.value }) })))),
          error ? h('p', { role: 'alert', style: { color: '#d9534f' } }, error) : null,
          h('div', { className: 'dsh-agy-stack', style: { gap: 8, justifyContent: 'flex-end' } },
            h('button', { type: 'button', className: 'dsh-agy-btn', onClick: () => { setProviderName(''); setNames({}) } }, t('Reset aliases', '重置别名')),
            h('button', { type: 'button', className: 'dsh-agy-btn', onClick: () => setEditing(false) }, t('Cancel', '取消')),
            h('button', { type: 'button', className: 'dsh-agy-btn', disabled: busy, onClick: () => void save() }, busy ? '…' : t('Save aliases', '保存别名')))) : null)
    }

    function SettingsCard(props) {
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      // Accordion: at most one choice row is expanded at a time.
      const [openKey, setOpenKey] = React.useState(null)
      const rootRef = React.useRef(null)
      const load = React.useCallback(async (warm) => {
        setRefreshing(true)
        try {
          const s = warm ? await props.client.warmup() : await props.client.status()
          setStatus(s)
          rememberSettings(s)
          setError(s.error || null)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setRefreshing(false)
        }
      }, [props.client])
      const applyPatch = React.useCallback(async (patch) => {
        setBusy(true)
        try {
          const s = await props.client.configure(patch)
          setStatus(s)
          rememberSettings(s)
          setError(s.error || null)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }, [props.client])
      // Account operations report their own status back (sign-in changes the
      // credential store, not only the account list), so the card adopts it
      // without flashing the shared busy state.
      const adoptStatus = React.useCallback((s) => {
        if (s === null || typeof s !== 'object') return
        setStatus(s)
        rememberSettings(s)
        setError(s.error || null)
      }, [])
      React.useEffect(() => { void load(false) }, [load])
      // Outside pointerdown or Escape collapses the open settings sub-list.
      React.useEffect(() => {
        if (openKey === null) return undefined
        const onPointerDown = (e) => {
          const root = rootRef.current
          if (!root) return
          const inside = typeof root.contains === 'function' ? root.contains(e.target) : root === e.target
          if (!inside) setOpenKey(null)
        }
        const onDocKeyDown = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault?.()
            e.stopPropagation?.()
            setOpenKey(null)
          }
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onDocKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onDocKeyDown, true)
        }
      }, [openKey])
      const stateText = status ? { idle: t('Idle', '待命'), starting: t('Starting', '启动中'), ready: t('Connected', '已连接'), error: t('Error', '异常') }[status.state] : '…'
      // Status row: a semantic-color dot badge plus version / context / unlock
      // tags. All decoration is text-free so textOf() stays readable.
      const statusBadges = h('span', { className: 'dsh-agy-stack', style: { justifyContent: 'flex-end', alignItems: 'center', gap: 8 } },
        status && status.state === 'idle' ? null : h('span', { className: 'dsh-agy-badge' },
          h('span', { className: 'dsh-agy-dot', style: { background: stateDotColor(status && status.state) } }),
          stateText),
        h('span', { className: 'dsh-agy-tag' }, `v${(status && status.version) || '—'}`),
        h('span', { className: 'dsh-agy-tag' }, tokens((status && status.contextWindow) || 0)),
        status && status.unlock && status.unlock.status === 'unlocked' ? h('span', { className: 'dsh-agy-tag' }, t('Unlocked', '已解锁')) : null)
      return h('section', { className: 'antigravity-settings-card' },
        h('div', { className: 'dsh-agy-header' },
          h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 600, lineHeight: '24px' } }, 'Antigravity'),
          h('button', {
            type: 'button',
            className: 'dsh-agy-btn dsh-agy-btn-settings',
            disabled: refreshing || busy,
            onClick: () => void load(true),
          }, refreshIcon(), refreshing || busy ? '…' : t('Refresh', '刷新'))),
        h('div', { className: 'dsh-agy-settings-body', ref: rootRef },
          status ? h('div', { className: 'dsh-agy-card' },
            h(InfoRow, { label: t('Status', '状态') }, statusBadges),
            h(ChoiceRow, {
              label: t('Window', '上下文窗口'),
              options: windowOptions(),
              value: status.configuredContextWindow ?? 0,
              disabled: busy,
              open: openKey === 'window',
              onToggle: (next) => setOpenKey(next ? 'window' : null),
              onChange: (v) => void applyPatch({ contextWindow: v }),
            }),
            h(ChoiceRow, {
              label: t('Default effort', '默认思考'),
              options: EFFORT_OPTIONS,
              value: status.defaultEffort || 'high',
              disabled: busy,
              open: openKey === 'effort',
              onToggle: (next) => setOpenKey(next ? 'effort' : null),
              onChange: (v) => void applyPatch({ defaultEffort: v }),
            }),
            h(ChoiceRow, {
              label: t('Long decode', '超长续写'),
              hint: t(
                'When one reply hits the length limit before it is finished, this is how many times it continues on its own. Off stops there.',
                '一次写到长度上限、没写完时，自动接着写的段数。选「关闭」就写满停下。',
              ),
              options: decodeOptions(),
              value: status.longDecodeContinuations ?? 3,
              disabled: busy,
              open: openKey === 'decode',
              onToggle: (next) => setOpenKey(next ? 'decode' : null),
              onChange: (v) => void applyPatch({ longDecodeContinuations: v }),
            }),
            h(ChoiceRow, {
              label: t('Degraded route', '降智处理'),
              hint: t(
                'What happens when an answer looks off. 128K re-asks only when the request was cut at 128K and the rest was not seen; other signs are only marked. Full re-asks whenever it looks downgraded. Monitor keeps the answer and only marks it.',
                '发现这次回答不正常时怎么处理。128K截断重答：只有内容被砍到前 128K、后面没被看到时才重答，其他异常只提示。全量降智拦截重答：只要像被降智了就丢掉重答。仅监测提示：回答照常显示，只在胶囊上做记号。',
              ),
              options: degradeOptions(),
              value: status.degradeAction || 'truncation',
              disabled: busy,
              open: openKey === 'degrade',
              onToggle: (next) => setOpenKey(next ? 'degrade' : null),
              onChange: (v) => void applyPatch({ degradeAction: v }),
            }),
            h(ChoiceRow, {
              label: t('Engine mode', '引擎模式'),
              hint: t(
                'Who reads files, edits them, and runs commands. Bridge: the model thinks and DSH does that work. Native: Antigravity’s own tools do that work, while subagents, skills, and todos stay with DSH.',
                '谁来读文件、改文件、跑命令。DSH 工具桥接：模型只负责想，这些活由 DSH 来做。原生 Agent（满血）：这些活由 Antigravity 自己的工具来做，子代理、技能、待办仍由 DSH 提供。',
              ),
              options: engineOptions(),
              value: status.engineMode || 'bridge',
              disabled: busy,
              open: openKey === 'engine',
              onToggle: (next) => setOpenKey(next ? 'engine' : null),
              onChange: (v) => void applyPatch({ engineMode: v }),
            }))
            : null,
          status ? h(DisplayAliases, { status, client: props.client, onStatus: adoptStatus }) : null,
          // Provider-level allowlist: the same block the Models page card renders.
          status ? h(MS.ModelSelectionBlock, {
            adapter: antigravityModelAdapter(props.client),
            disabled: busy,
            onStatus: adoptStatus,
          }) : null,
          status ? h(AccountsPanel, { accounts: status.accounts, client: props.client, onStatus: adoptStatus }) : null),
        error ? h('div', { role: 'alert', style: { color: '#d9534f', fontSize: 12 } }, error) : null)
    }

    /**
     * Provider parameter rows in the composer's model menu: the same two live
     * settings as the Settings section, at the moment a model is being chosen.
     * Everything is applied through `configure`, so the next request reads the
     * new value and the menu stays open.
     */
    function ModelParameterRows(props) {
      const state = useStore(props.directory.store)
      const selection = state && state.current
      const active = !!selection && selection.provider === PROVIDER
      const [status, setStatus] = React.useState(cachedSettings)
      const [busy, setBusy] = React.useState(false)
      // Accordion: at most one parameter panel is open at a time.
      const [openKey, setOpenKey] = React.useState(null)
      const rootRef = React.useRef(null)
      const contextButtonRef = React.useRef(null)
      const decodeButtonRef = React.useRef(null)
      React.useEffect(() => {
        if (!active) return undefined
        let live = true
        props.client.statusNow().then((s) => { if (live && s) { rememberSettings(s); setStatus({ ...s }) } }).catch(() => { /* keep the last observation */ })
        return () => { live = false }
      }, [active, props.client])
      // Leaving the menu or locking the rows collapses any open panel.
      React.useEffect(() => {
        if (!active || props.locked) setOpenKey(null)
      }, [active, props.locked])
      // Outside pointerdown or document-capture Escape collapses the open
      // sub-list first — even when ModelSelect kept DOM focus on its trigger
      // button via mousedown preventDefault().
      React.useEffect(() => {
        if (openKey === null) return undefined
        const buttonRefsByKey = { context: contextButtonRef, decode: decodeButtonRef }
        const onPointerDown = (e) => {
          const root = rootRef.current
          if (!root) return
          const inside = typeof root.contains === 'function' ? root.contains(e.target) : root === e.target
          if (!inside) setOpenKey(null)
        }
        const onDocKeyDown = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault?.()
            e.stopPropagation?.()
            const root = rootRef.current
            const activeEl = typeof document !== 'undefined' ? document.activeElement : null
            if (root && activeEl && typeof root.contains === 'function' && root.contains(activeEl)) {
              buttonRefsByKey[openKey]?.current?.focus?.()
            }
            setOpenKey(null)
          }
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onDocKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onDocKeyDown, true)
        }
      }, [openKey])
      if (!active) return null
      const buttonRefs = { context: contextButtonRef, decode: decodeButtonRef }
      // First Escape collapses the open sub-list (and stops the menu-level
      // handler); a second Escape, with no sub-list open, lets the menu close.
      const onKeyDown = (e) => {
        if (openKey !== null && e.key === 'Escape') {
          e.preventDefault?.()
          e.stopPropagation?.()
          const ref = buttonRefs[openKey]
          ref?.current?.focus?.()
          setOpenKey(null)
        }
      }
      const fail = (message) => { if (typeof props.reportFailure === 'function') props.reportFailure(message) }
      const apply = (patch) => {
        if (props.locked || busy) return
        setBusy(true)
        props.client.configure(patch).then((s) => {
          rememberSettings(s)
          setStatus({ ...cachedSettings, ...s })
        }, (error) => {
          fail(error instanceof Error ? error.message : String(error))
        }).finally(() => setBusy(false))
      }
      return h('div', { className: 'dsh-agy-list', ref: rootRef, onKeyDown },
        h(ChoiceRow, {
          menu: true,
          label: t('Context', '上下文'),
          options: windowOptions(),
          value: status ? status.configuredContextWindow ?? 0 : 0,
          disabled: props.locked || busy,
          open: openKey === 'context',
          onToggle: (next) => setOpenKey(next ? 'context' : null),
          buttonRef: contextButtonRef,
          onChange: (v) => apply({ contextWindow: v }),
        }),
        h(ChoiceRow, {
          menu: true,
          label: t('Long decode', '超长续写'),
          options: decodeOptions(),
          value: status ? status.longDecodeContinuations ?? 3 : 3,
          disabled: props.locked || busy,
          open: openKey === 'decode',
          onToggle: (next) => setOpenKey(next ? 'decode' : null),
          buttonRef: decodeButtonRef,
          onChange: (v) => apply({ longDecodeContinuations: v }),
        }))
    }

    return {
      name: PACKAGE,
      inject: ['slots', 'remote'],
      apply(ctx) {
        try {
          const mounted = ctx.remote.$mount({ package: PACKAGE, descriptors: DESCRIPTORS })
          ctx.effect(() => mounted, 'antigravity-acp: mount remote')
        } catch (error) {
          console.error('[dsh-llm-antigravity-acp] remote mount failed:', error)
        }
        const client = makeClient(ctx)
        ctx.effect(() => {
          ensureStyles()
          // Warm the live settings once per page load so the menu rows paint
          // from the cached copy instead of waiting on a round-trip.
          let live = true
          client.statusNow().then((s) => { if (live) rememberSettings(s) }).catch(() => { /* the rows fall back to the last stored copy */ })
          return () => { live = false }
        }, 'antigravity-acp: row styles and live settings')
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'antigravity-acp',
          order: 41,
          label: () => 'Antigravity',
          inject: () => ({ client }),
        }, SettingsCard)), 'antigravity-acp: settings section')
        // Second entry point: the Models page's Antigravity card. Both write
        // `visibleModels` through one remote.
        ctx.effect(() => ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
          name: 'settings.models.provider-card',
          key: 'llm-antigravity-acp',
          inject: () => ({ adapter: antigravityModelAdapter(client) }),
        }, MS.ModelSelectionBlock)), 'antigravity-acp: model catalog card')
        ctx.inject(['slots', 'modelDirectories'], (scope) => {
          scope.effect(() => scope.slots.inject('conversation.input.right', () => scope.slots.register({
            name: 'conversation.input.right',
            id: 'antigravity-acp-quota',
            order: 1001,
            inject: (sessionId) => ({ store: scope.modelDirectories.directoryFor(sessionId).store, client, sessionId }),
          }, QuotaPill)), 'antigravity-acp: quota pill')
          scope.effect(() => scope.slots.inject('conversation.input.model.parameters', () => scope.slots.register({
            name: 'conversation.input.model.parameters',
            id: 'antigravity-acp-parameters',
            order: 100,
            inject: (sessionId) => ({ directory: scope.modelDirectories.directoryFor(sessionId), client, sessionId }),
          }, ModelParameterRows)), 'antigravity-acp: model parameter rows')
        })
      },
    }
  },
})

})();
