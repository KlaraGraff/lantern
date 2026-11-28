// Bounds how many fixed-layout pages stay loaded in the page-at-a-time
// renderer. Formats that hold real memory per loaded page (PDF: a rendered
// page plus pdf.js's parsed operator lists and images, on the main thread and
// in the Worker) expose `section.unload`; the scroll renderer already calls it
// for pages that leave its buffer. The paginated renderer never did, so every
// page ever turned to stayed loaded until the book was closed.
//
// `touch` marks a page as just used; `trim` unloads the least recently used
// pages beyond `keep`, never one that is on screen. Keeping a few recent pages
// means turning back and forth does not re-render each time.
export const createSectionRetention = ({ keep, unload }) => {
    // A Set iterates in insertion order, so re-adding moves an index to the
    // most recent end and the first entries are the least recently used.
    const recent = new Set()
    return {
        touch(index) {
            if (!(index >= 0)) return
            recent.delete(index)
            recent.add(index)
        },
        trim(showing) {
            for (const index of recent) {
                if (recent.size <= keep) break
                if (showing.has(index)) continue
                recent.delete(index)
                unload(index)
            }
        },
        get size() {
            return recent.size
        },
    }
}
