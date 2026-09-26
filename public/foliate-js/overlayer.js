const createSVGElement = tag =>
    document.createElementNS('http://www.w3.org/2000/svg', tag)

const fontMetrics = new WeakMap()

const fontBoxHeight = range => {
    const node = range?.startContainer
    const element = node?.nodeType === 1 ? node : node?.parentElement
    const doc = element?.ownerDocument
    const view = doc?.defaultView
    if (!view) return null
    const style = view.getComputedStyle(element)
    const size = Number.parseFloat(style.fontSize)
    if (!Number.isFinite(size) || size <= 0) return null
    const font = `${style.fontStyle} ${style.fontWeight} ${size}px ${style.fontFamily}`
    let metrics = fontMetrics.get(doc)
    if (!metrics) {
        metrics = { context: doc.createElement('canvas').getContext('2d'), heights: new Map() }
        fontMetrics.set(doc, metrics)
    }
    if (!metrics.heights.has(font)) {
        let height = 0
        if (metrics.context) {
            try {
                metrics.context.font = font
                const measured = metrics.context.measureText('Hxbdfgjpqy')
                height = (measured.fontBoundingBoxAscent ?? 0)
                    + (measured.fontBoundingBoxDescent ?? 0)
            } catch {}
        }
        metrics.heights.set(font, height > 0 ? height : size * 1.2)
    }
    return metrics.heights.get(font)
}

export class Overlayer {
    #svg = createSVGElement('svg')
    #map = new Map()
    constructor() {
        Object.assign(this.#svg.style, {
            position: 'absolute', top: '0', left: '0',
            width: '100%', height: '100%',
            pointerEvents: 'none',
        })
    }
    get element() {
        return this.#svg
    }
    add(key, range, draw, options) {
        if (this.#map.has(key)) this.remove(key)
        if (typeof range === 'function') range = range(this.#svg.getRootNode())
        const rects = range.getClientRects()
        const element = draw(rects, options)
        this.#svg.append(element)
        this.#map.set(key, { range, draw, options, element, rects })
        if (!options?.search) this.redrawSearch()
    }
    remove(key) {
        if (!this.#map.has(key)) return
        this.#svg.removeChild(this.#map.get(key).element)
        const search = this.#map.get(key).options?.search
        this.#map.delete(key)
        if (!search) this.redrawSearch()
    }
    redraw() {
        for (const obj of this.#map.values()) {
            if (obj.options?.search) continue
            const { range, draw, options, element } = obj
            this.#svg.removeChild(element)
            const rects = range.getClientRects()
            const el = draw(rects, options)
            this.#svg.append(el)
            obj.element = el
            obj.rects = rects
        }
        this.redrawSearch()
    }
    redrawSearch() {
        for (const obj of this.#map.values()) {
            if (!obj.options?.search) continue
            const { range, draw, options, element } = obj
            this.#svg.removeChild(element)
            const rects = range.getClientRects()
            const el = draw(rects, options)
            this.#svg.append(el)
            obj.element = el
            obj.rects = rects
        }
    }
    overlaps(rects, include) {
        for (const [key, obj] of this.#map) {
            if (!include(key, obj)) continue
            for (const a of rects) for (const b of obj.rects)
                if (a.left < b.right && a.right > b.left
                && a.top < b.bottom && a.bottom > b.top) return true
        }
        return false
    }
    hitTest({ x, y }, include = () => true) {
        const arr = Array.from(this.#map.entries())
        // loop in reverse to hit more recently added items first
        for (let i = arr.length - 1; i >= 0; i--) {
            const [key, obj] = arr[i]
            if (!include(key, obj)) continue
            for (const { left, top, right, bottom } of obj.rects)
                if (top <= y && left <= x && bottom > y && right > x)
                    return [key, obj.range]
        }
        return []
    }
    static underline(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 2, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', color)
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr')
            for (const { right, top, height } of rects) {
                const el = createSVGElement('rect')
                el.setAttribute('x', right - strokeWidth)
                el.setAttribute('y', top)
                el.setAttribute('height', height)
                el.setAttribute('width', strokeWidth)
                g.append(el)
            }
        else for (const { left, bottom, width } of rects) {
            const el = createSVGElement('rect')
            el.setAttribute('x', left)
            el.setAttribute('y', bottom - strokeWidth)
            el.setAttribute('height', strokeWidth)
            el.setAttribute('width', width)
            g.append(el)
        }
        return g
    }
    static strikethrough(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 2, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', color)
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr')
            for (const { right, left, top, height } of rects) {
                const el = createSVGElement('rect')
                el.setAttribute('x', (right + left) / 2)
                el.setAttribute('y', top)
                el.setAttribute('height', height)
                el.setAttribute('width', strokeWidth)
                g.append(el)
            }
        else for (const { left, top, bottom, width } of rects) {
            const el = createSVGElement('rect')
            el.setAttribute('x', left)
            el.setAttribute('y', (top + bottom) / 2)
            el.setAttribute('height', strokeWidth)
            el.setAttribute('width', width)
            g.append(el)
        }
        return g
    }
    static squiggly(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 2, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', 'none')
        g.setAttribute('stroke', color)
        g.setAttribute('stroke-width', strokeWidth)
        const block = strokeWidth * 1.5
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr')
            for (const { right, top, height } of rects) {
                const el = createSVGElement('path')
                const n = Math.round(height / block / 1.5)
                const inline = height / n
                const ls = Array.from({ length: n },
                    (_, i) => `l${i % 2 ? -block : block} ${inline}`).join('')
                el.setAttribute('d', `M${right} ${top}${ls}`)
                g.append(el)
            }
        else for (const { left, bottom, width } of rects) {
            const el = createSVGElement('path')
            const n = Math.round(width / block / 1.5)
            const inline = width / n
            const ls = Array.from({ length: n },
                (_, i) => `l${inline} ${i % 2 ? block : -block}`).join('')
            el.setAttribute('d', `M${left} ${bottom}${ls}`)
            g.append(el)
        }
        return g
    }
    static highlight(rects, options = {}) {
        const { color = 'red' } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', color)
        g.style.opacity = 'var(--overlayer-highlight-opacity, .3)'
        g.style.mixBlendMode = 'var(--overlayer-highlight-blend-mode, normal)'
        for (const { left, top, height, width } of rects) {
            const el = createSVGElement('rect')
            el.setAttribute('x', left)
            el.setAttribute('y', top)
            el.setAttribute('height', height)
            el.setAttribute('width', width)
            g.append(el)
        }
        return g
    }
    static search(rects, { color = '#8b5cf6', active = false,
        overlap = false, range } = {}) {
        const g = createSVGElement('g')
        const boxHeight = fontBoxHeight(range)
        for (const { left, top, height, width } of rects) {
            if (width <= 0 || height <= 0) continue
            const inset = boxHeight ? Math.max(0, (height - boxHeight) / 2) : 0
            const rect = createSVGElement('rect')
            rect.setAttribute('x', left)
            rect.setAttribute('y', top + inset)
            rect.setAttribute('height', height - inset * 2)
            rect.setAttribute('width', width)
            rect.setAttribute('rx', 3)
            rect.setAttribute('fill', overlap ? 'none' : color)
            rect.setAttribute('fill-opacity', active ? '.23' : '.12')
            if (active || overlap) {
                rect.setAttribute('stroke', color)
                rect.setAttribute('stroke-opacity', active ? '.76' : '.52')
                rect.setAttribute('stroke-width', '1')
            }
            g.append(rect)
        }
        return g
    }
    static outline(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 3, radius = 3 } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', 'none')
        g.setAttribute('stroke', color)
        g.setAttribute('stroke-width', strokeWidth)
        for (const { left, top, height, width } of rects) {
            const el = createSVGElement('rect')
            el.setAttribute('x', left)
            el.setAttribute('y', top)
            el.setAttribute('height', height)
            el.setAttribute('width', width)
            el.setAttribute('rx', radius)
            g.append(el)
        }
        return g
    }
    // make an exact copy of an image in the overlay
    // one can then apply filters to the entire element, without affecting them;
    // it's a bit silly and probably better to just invert images twice
    // (though the color will be off in that case if you do heu-rotate)
    static copyImage([rect], options = {}) {
        const { src } = options
        const image = createSVGElement('image')
        const { left, top, height, width } = rect
        image.setAttribute('href', src)
        image.setAttribute('x', left)
        image.setAttribute('y', top)
        image.setAttribute('height', height)
        image.setAttribute('width', width)
        return image
    }
}
