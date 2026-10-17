/**
 * Iconify Picker Web Component
 * Zero-dependency, framework-agnostic icon picker
 */

const API = 'https://api.iconify.design'

// Iconify docs recommend splitting icon data queries longer than this
const MAX_URL_LENGTH = 500

// Shared by all instances so remounts, searches and page flips reuse responses
const responses = new Map()
const iconData = new Map() // prefix -> Map<name, resolved icon | null>

function getJSON(url) {
  if (!responses.has(url)) {
    const request = fetch(url).then(res => {
      if (!res.ok) throw new Error(`${res.status} ${url}`)
      return res.json()
    })
    request.catch(() => responses.delete(url))
    responses.set(url, request)
  }
  return responses.get(url)
}

// Same alias/transformation merge rules as @iconify/utils
const mergeIcon = (parent, child) => ({
  ...parent,
  ...child,
  rotate: ((parent.rotate || 0) + (child.rotate || 0)) % 4,
  hFlip: !parent.hFlip !== !child.hFlip,
  vFlip: !parent.vFlip !== !child.vFlip,
})

function resolveIcon(data, name) {
  const defaults = { left: data.left ?? 0, top: data.top ?? 0, width: data.width ?? 16, height: data.height ?? 16 }
  let props = {}
  for (let depth = 0; depth < 36; depth++) {
    if (data.icons?.[name]) return mergeIcon(defaults, mergeIcon(data.icons[name], props))
    const alias = data.aliases?.[name]
    if (!alias) return null
    props = mergeIcon(alias, props)
    name = alias.parent
  }
  return null
}

// Port of iconToSVG() from @iconify/utils, without customisations
function toSVG({ left, top, width, height, rotate, hFlip, vFlip, body }) {
  const transforms = []
  if (hFlip && vFlip) rotate += 2
  else if (hFlip) {
    transforms.push(`translate(${width + left} ${-top})`, 'scale(-1 1)')
    left = top = 0
  } else if (vFlip) {
    transforms.push(`translate(${-left} ${height + top})`, 'scale(1 -1)')
    left = top = 0
  }

  rotate = ((rotate % 4) + 4) % 4
  if (rotate === 1) transforms.unshift(`rotate(90 ${height / 2 + top} ${height / 2 + top})`)
  if (rotate === 2) transforms.unshift(`rotate(180 ${width / 2 + left} ${height / 2 + top})`)
  if (rotate === 3) transforms.unshift(`rotate(-90 ${width / 2 + left} ${width / 2 + left})`)
  if (rotate % 2) [left, top, width, height] = [top, left, height, width]

  if (transforms.length) body = `<g transform="${transforms.join(' ')}">${body}</g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${(24 * width) / height}" height="24" viewBox="${left} ${top} ${width} ${height}">${body}</svg>`
}

const svgDataUrl = svg => `data:image/svg+xml,${encodeURIComponent(svg)}`
const BLANK_IMAGE = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"/>')

function loadIconData(prefix, names) {
  if (!iconData.has(prefix)) iconData.set(prefix, new Map())
  const known = iconData.get(prefix)

  // Sorted so the same page always produces the same (HTTP-cacheable) URLs
  const missing = [...new Set(names)].filter(name => !known.has(name)).sort()
  const base = `${API}/${prefix}.json?icons=`
  const chunks = []
  let chunk = []
  let length = base.length
  for (const name of missing) {
    if (chunk.length && length + name.length + 1 > MAX_URL_LENGTH) {
      chunks.push(chunk)
      chunk = []
      length = base.length
    }
    chunk.push(name)
    length += name.length + 1
  }
  if (chunk.length) chunks.push(chunk)

  return Promise.all(chunks.map(chunk =>
    getJSON(base + chunk.join(',')).then(data => {
      for (const name of chunk) known.set(name, resolveIcon(data, name))
    })
  ))
}

class IconifyPicker extends HTMLElement {
  static observedAttributes = [
    'collection',
    'page-size',
    'height',
    'theme',
    'search',
    'selected',
    'mode',
    'button-label',
    'filter',
    'hidden',
    'hide-search',
    'hide-collection',
  ]

  // Attribute to state key mapping
  static attrMap = {
    collection: 'currentCollection',
    'page-size': 'pageSize',
    theme: 'theme',
    search: 'searchTerm',
    selected: 'selectedIcon',
    mode: 'mode',
    'button-label': 'buttonLabel',
    filter: 'filter',
  }

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this.cache = new Map()
    this.#initState()
    this.shadowRoot.innerHTML = this.#template()
    this.#bindEvents()
    this.#loadCollections()
  }

  #initState() {
    const initial = {
      collections: [],
      currentCollection: '',
      icons: [],
      searchTerm: '',
      pageSize: 60,
      currentPage: 0,
      totalPages: 0,
      selectedIcon: null,
      loading: false,
      error: null,
      theme: 'auto',
      mode: 'inline',
      buttonLabel: 'Choose Icon',
      filter: '',
      open: false,
    }

    this.state = new Proxy(initial, {
      set: (obj, prop, val) => {
        if (obj[prop] === val) return true
        obj[prop] = val
        this.#scheduleRender()
        return true
      },
    })
  }

  #scheduleRender() {
    if (this._pending) return
    this._pending = true
    requestAnimationFrame(() => {
      this.#render()
      this._pending = false
    })
  }

  #template() {
    return /*html*/ `
<style>
:host {
  display: block;
  width: 100%;
  height: 100%;
  font-family: system-ui, sans-serif;
  /* Main colors */
  --picker-primary: var(--primary, #ff5c8a);
  --picker-bg: var(--bg, #181825);
  --picker-text: var(--text, #f5f5f5);
  --picker-border: var(--border, #313244);
  --picker-hover: var(--hover, #1e1e2e);
  /* Element colors */
  --picker-header-bg: var(--header-bg, var(--picker-bg));
  --picker-input-bg: var(--input-bg, #252535);
  --picker-input-text: var(--input-text, var(--picker-text));
  --picker-icon-color: var(--icon-color, var(--picker-text));
  --picker-footer-bg: var(--footer-bg, var(--picker-bg));
  /* Base sizing */
  --picker-radius: var(--radius, 12px);
  --picker-border-width: var(--border-width, 3px);
  --picker-padding: var(--padding, 1rem);
  --picker-gap: var(--gap, 0.5rem);
  --picker-icon-size: var(--icon-size, 24px);
  --picker-cell-size: var(--cell-size, 60px);
  /* Granular radius */
  --picker-container-radius: var(--container-radius, var(--picker-radius));
  --picker-input-radius: var(--input-radius, 8px);
  --picker-icon-radius: var(--icon-radius, 6px);
  --picker-button-radius: var(--button-radius, 8px);
  /* Granular border width */
  --picker-container-border-width: var(--container-border-width, var(--picker-border-width));
  --picker-input-border-width: var(--input-border-width, 1px);
  --picker-icon-border-width: var(--icon-border-width, 1px);
  /* Scrollbar */
  --picker-scrollbar-width: var(--scrollbar-width, thin);
  --picker-scrollbar-color: var(--scrollbar-color, var(--picker-primary));
  --picker-scrollbar-track: var(--scrollbar-track, transparent);
  --picker-scrollbar-hover: var(--scrollbar-hover, #ff8aa5);
  color-scheme: dark light;
}
.container {
  border: var(--picker-container-border-width) solid var(--picker-border);
  border-radius: var(--picker-container-radius);
  background: var(--picker-bg);
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 100%;
  color: var(--picker-text);
  overflow: hidden;
}
.header {
  padding: var(--picker-padding);
  border-bottom: 1px solid var(--picker-border);
  display: flex;
  gap: var(--picker-gap);
  background: var(--picker-header-bg);
}
.search {
  flex: 1;
  padding: 0.5rem 1rem;
  border: var(--picker-input-border-width) solid var(--picker-border);
  border-radius: var(--picker-input-radius);
  background: var(--picker-input-bg);
  color: var(--picker-input-text);
  font-size: 0.875rem;
}
.select {
  padding: 0.5rem 1rem;
  border: var(--picker-input-border-width) solid var(--picker-border);
  border-radius: var(--picker-input-radius);
  background: var(--picker-input-bg);
  color: var(--picker-input-text);
  font-size: 0.875rem;
  min-width: 150px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--picker-cell-size), 1fr));
  gap: var(--picker-gap);
  padding: var(--picker-padding);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: var(--picker-scrollbar-width);
  scrollbar-color: var(--picker-scrollbar-color) var(--picker-scrollbar-track);
}
.grid::-webkit-scrollbar { width: 8px; }
.grid::-webkit-scrollbar-track { background: var(--picker-scrollbar-track); }
.grid::-webkit-scrollbar-thumb { background: var(--picker-scrollbar-color); border-radius: 4px; }
.grid::-webkit-scrollbar-thumb:hover { background: var(--picker-scrollbar-hover); }
.icon {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.5rem;
  border: var(--picker-icon-border-width) solid transparent;
  border-radius: var(--picker-icon-radius);
  cursor: pointer;
  transition: all 0.15s;
}
.icon:hover {
  background: var(--picker-hover);
  border-color: var(--picker-primary);
}
.icon.selected {
  background: color-mix(in srgb, var(--picker-primary) 20%, transparent);
  border-color: var(--picker-primary);
}
.icon img {
  width: var(--picker-icon-size);
  height: var(--picker-icon-size);
  margin-bottom: 0.25rem;
}
.name {
  font-size: 0.7rem;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
  opacity: 0.8;
}
.footer {
  padding: var(--picker-padding);
  border-top: 1px solid var(--picker-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--picker-footer-bg);
}
.pagination {
  display: flex;
  gap: var(--picker-gap);
  align-items: center;
}
.btn {
  padding: 0.4rem 0.8rem;
  border: var(--picker-input-border-width) solid var(--picker-border);
  border-radius: var(--picker-button-radius);
  background: var(--picker-input-bg);
  color: var(--picker-input-text);
  cursor: pointer;
  font-size: 0.8rem;
}
.btn:hover:not(:disabled) { background: var(--picker-primary); color: #fff; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.selected-display {
  display: flex;
  align-items: center;
  gap: var(--picker-gap);
  font-size: 0.8rem;
}
.selected-display img { width: 24px; height: 24px; }
.status { padding: 2rem; text-align: center; opacity: 0.7; }
.toggle-btn {
  padding: 0.5rem 1rem;
  background: var(--picker-primary);
  color: #fff;
  border: none;
  border-radius: var(--picker-button-radius);
  cursor: pointer;
  font-weight: 600;
  margin-bottom: 0.5rem;
}
</style>
<div class="container" part="container">
  <div class="header" part="header">
    <input type="text" class="search" part="search" placeholder="Search icons..." />
    <select class="select" part="select"><option>Loading...</option></select>
  </div>
  <div class="grid" part="grid"><div class="status">Loading collections...</div></div>
  <div class="footer" part="footer">
    <div class="pagination" part="pagination">
      <button class="btn prev" part="button" disabled>Prev</button>
      <span class="page-info" part="page-info">Page 1</span>
      <button class="btn next" part="button" disabled>Next</button>
    </div>
    <div class="selected-display" part="selected"></div>
  </div>
</div>`
  }

  // Selectors
  $(s) { return this.shadowRoot.querySelector(s) }
  $$(s) { return [...this.shadowRoot.querySelectorAll(s)] }

  #bindEvents() {
    const debounce = (fn, ms = 250) => {
      let t
      return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
    }

    this.$('.search').oninput = debounce(e => {
      this.state.searchTerm = e.target.value
      this.state.currentPage = 0
      this.#loadIcons()
    })

    this.$('.select').onchange = e => {
      this.state.currentCollection = e.target.value
      this.state.currentPage = 0
      this.#loadIcons()
    }

    this.$('.prev').onclick = () => this.#navigate(-1)
    this.$('.next').onclick = () => this.#navigate(1)
  }

  #navigate(dir) {
    const { currentPage, totalPages } = this.state
    const next = currentPage + dir
    if (next >= 0 && next < totalPages) {
      this.state.currentPage = next
      this.#renderIcons()
      this.#renderPagination()
    }
  }

  async #loadCollections() {
    let data
    try {
      data = await getJSON(`${API}/collections`)
    } catch {
      return this.state.error = 'Failed to load collections'
    }

    const collections = Object.entries(data)
      .map(([prefix, info]) => ({ prefix, name: info.name || prefix, total: info.total || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name))

    this.state.collections = collections
    this.#populateSelect(collections)

    // Auto-select first or use attribute
    const initial = this.getAttribute('collection') || collections[0]?.prefix
    if (initial) {
      this.state.currentCollection = initial
      this.$('.select').value = initial
      this.#loadIcons()
    }
  }

  #populateSelect(collections) {
    this.$('.select').innerHTML = collections
      .map(c => `<option value="${c.prefix}">${c.name} (${c.total})</option>`)
      .join('')
  }

  async #loadIcons() {
    const { currentCollection, searchTerm } = this.state
    if (!currentCollection) return

    const key = `${currentCollection}:${searchTerm}`
    if (this.cache.has(key)) {
      this.state.icons = this.cache.get(key)
      return
    }

    this.state.loading = true
    let data
    try {
      data = await getJSON(`${API}/collection?prefix=${currentCollection}`)
    } catch {
      this.state.loading = false
      return this.state.error = 'Failed to load icons'
    }

    let icons = data.uncategorized || Object.values(data.categories || {}).flat() || []

    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      icons = icons.filter(n => n.toLowerCase().includes(term))
    }

    this.cache.set(key, icons)
    this.state.icons = icons
    this.state.loading = false
  }

  #render() {
    const { mode, open } = this.state
    const container = this.$('.container')
    if (!container) return

    // Mode handling
    if (mode === 'button') {
      if (!this.$('.toggle-btn')) {
        const btn = document.createElement('button')
        btn.className = 'toggle-btn'
        btn.setAttribute('part', 'toggle-button')
        btn.textContent = this.state.buttonLabel
        btn.onclick = () => this.toggle()
        this.shadowRoot.insertBefore(btn, container)
      }
      this.$('.toggle-btn').textContent = this.state.buttonLabel
      container.style.display = open ? 'grid' : 'none'
    } else if (mode === 'manual') {
      container.style.display = open ? 'grid' : 'none'
    } else {
      container.style.display = 'grid'
    }

    this.#renderIcons()
    this.#renderPagination()
    this.#renderSelected()
    this.#updateVisibility()
  }

  // Fetches any missing icon data in one batch, then re-renders once it arrives
  #ensureIconData(prefix, names) {
    const known = iconData.get(prefix)
    if (names.every(name => known?.has(name))) return
    loadIconData(prefix, names).then(() => this.#scheduleRender(), () => {})
  }

  #cssColorToHex(color) {
    if (!color || color === 'transparent') return null
    
    // Already hex format
    if (color.startsWith('#')) return color
    
    // Handle rgb/rgba format - getComputedStyle returns rgb() format
    const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
    if (rgbMatch) {
      const r = parseInt(rgbMatch[1], 10).toString(16).padStart(2, '0')
      const g = parseInt(rgbMatch[2], 10).toString(16).padStart(2, '0')
      const b = parseInt(rgbMatch[3], 10).toString(16).padStart(2, '0')
      return `#${r}${g}${b}`
    }
    
    return null
  }

  #getIconColor() {
    // Read CSS variable directly from inline style (set by customization script)
    const inlineValue = this.style.getPropertyValue('--picker-icon-color')?.trim()
    
    // If we have an inline value (not a CSS variable reference), use it directly
    if (inlineValue && !inlineValue.startsWith('var(')) {
      // Value is already set (e.g., "#ff0099" or "rgb(...)")
      const hex = this.#cssColorToHex(inlineValue)
      if (hex) return hex
    }
    
    // Fallback: resolve CSS variable from computed styles
    const temp = document.createElement('div')
    document.body.appendChild(temp)
    temp.style.setProperty('color', 'var(--picker-icon-color)')
    const iconColor = getComputedStyle(temp).color
    temp.style.setProperty('color', 'var(--picker-text)')
    const textColor = getComputedStyle(temp).color
    document.body.removeChild(temp)
    
    // Return null if colors are the same or invalid
    if (!iconColor || iconColor === 'rgba(0, 0, 0, 0)' || iconColor === textColor) return null
    
    return this.#cssColorToHex(iconColor)
  }

  // Builds the image locally from batched icon data instead of one API request per icon
  #getIconUrl(collection, name) {
    const icon = iconData.get(collection)?.get(name)
    if (!icon) return BLANK_IMAGE
    const color = this.#getIconColor()
    return svgDataUrl(toSVG(color ? { ...icon, body: icon.body.replaceAll('currentColor', color) } : icon))
  }

  #renderIcons() {
    const grid = this.$('.grid')
    const { icons, currentPage, pageSize, loading, error, currentCollection, selectedIcon } = this.state

    if (loading) return grid.innerHTML = '<div class="status">Loading...</div>'
    if (error) return grid.innerHTML = `<div class="status">${error}</div>`

    const total = Math.ceil(icons.length / pageSize)
    if (total !== this.state.totalPages) this.state.totalPages = total

    const page = icons.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
    if (!page.length) return grid.innerHTML = '<div class="status">No icons found</div>'

    this.#ensureIconData(currentCollection, page)

    grid.innerHTML = page.map(name => {
      const full = `${currentCollection}:${name}`
      const sel = selectedIcon === full ? 'selected' : ''
      return `<div class="icon ${sel}" part="icon" data-name="${name}">
        <img src="${this.#getIconUrl(currentCollection, name)}" part="icon-image" alt="${name}">
        <span class="name" part="icon-name">${name}</span>
      </div>`
    }).join('')

    grid.onclick = e => {
      const icon = e.target.closest('.icon')
      if (icon) this.#selectIcon(icon.dataset.name)
    }
  }

  #renderPagination() {
    const { currentPage, totalPages } = this.state
    this.$('.prev').disabled = currentPage === 0
    this.$('.next').disabled = currentPage >= totalPages - 1
    this.$('.page-info').textContent = `Page ${currentPage + 1} of ${totalPages || 1}`
  }

  #renderSelected() {
    const { selectedIcon } = this.state
    const el = this.$('.selected-display')
    if (!selectedIcon) return el.innerHTML = ''

    const [prefix, name] = selectedIcon.split(':')
    if (!name) return el.innerHTML = `<span>${selectedIcon}</span>`

    this.#ensureIconData(prefix, [name])
    el.innerHTML = `<span>${selectedIcon}</span><img src="${this.#getIconUrl(prefix, name)}" alt="${name}">`
  }

  #updateVisibility() {
    const searchEl = this.$('.search')
    const selectEl = this.$('.select')
    const headerEl = this.$('.header')
    if (!searchEl || !selectEl || !headerEl) return

    const hideSearch = this.hasAttribute('hide-search')
    const hideCollection = this.hasAttribute('hide-collection')

    searchEl.style.display = hideSearch ? 'none' : ''
    selectEl.style.display = hideCollection ? 'none' : ''
    headerEl.style.display = (hideSearch && hideCollection) ? 'none' : ''
  }

  async #selectIcon(name) {
    const { currentCollection } = this.state
    const iconName = `${currentCollection}:${name}`
    this.state.selectedIcon = iconName

    // Fetch SVG
    const res = await fetch(`${API}/${currentCollection}/${name}.svg`)
    const svg = await res.text()

    const detail = { iconName, collection: currentCollection, name, svg }
    this.dispatchEvent(new CustomEvent('icon-selected', { detail, bubbles: true }))
    this.dispatchEvent(new CustomEvent('change', { detail, bubbles: true }))
  }

  attributeChangedCallback(attr, old, val) {
    if (old === val) return

    const key = IconifyPicker.attrMap[attr]
    if (key) {
      const parsed = attr === 'page-size' ? (parseInt(val, 10) || 60) : val
      this.state[key] = parsed
      if (['collection', 'search', 'filter'].includes(attr)) this.#loadIcons()
      if (attr === 'mode') {
        this.state.open = parsed === 'inline'
        if (this.shadowRoot && this.$('.container')) {
          this.#render()
        }
      }
    }

    if (attr === 'height') this.style.height = val
    if (attr === 'hidden') this.state.open = val === null
    if (['hide-search', 'hide-collection'].includes(attr)) this.#updateVisibility()
  }

  connectedCallback() {
    const mode = this.getAttribute('mode') || 'inline'
    if (this.state.mode !== mode) {
      this.state.mode = mode
    }
    this.state.open = mode === 'inline'
    this.#render()
    this.#updateVisibility()
  }

  // Public API
  show() { this.state.open = true; this.removeAttribute('hidden') }
  hide() { this.state.open = false; this.setAttribute('hidden', '') }
  toggle() { this.state.open ? this.hide() : this.show() }

  reset() {
    this.state.selectedIcon = null
    this.state.searchTerm = ''
    this.$('.search').value = ''
    this.#loadIcons()
  }

  focus() {
    (this.$('.toggle-btn') || this.$('.search'))?.focus()
  }

  forceRedraw() {
    this.#renderIcons()
    this.#renderSelected()
  }
}

customElements.define('iconify-picker', IconifyPicker)
export default IconifyPicker
