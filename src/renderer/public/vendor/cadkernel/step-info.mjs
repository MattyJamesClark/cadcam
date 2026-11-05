/* Product data and header of a STEP file, read straight from the text. */

// ---- STEP product data ----------------------------------------------------------
// XCAF keeps names but drops the rest of the product data (part number,
// description, revision...). It is plain text in the file, so read it directly.

const PROD_TYPES = /^(PRODUCT|PRODUCT_DEFINITION_FORMATION(?:_WITH_SPECIFIED_SOURCE)?|PRODUCT_DEFINITION|PRODUCT_RELATED_PRODUCT_CATEGORY)$/

/** Split a STEP argument list into top-level values (strings unquoted, lists as arrays). */
function stepArgs(src) {
  let i = 0
  const value = () => {
    while (src[i] === ' ' || src[i] === '\n' || src[i] === '\r') i++
    if (src[i] === "'") {
      let out = ''
      i++
      for (;;) {
        const j = src.indexOf("'", i)
        if (j < 0) { out += src.slice(i); i = src.length; break }
        out += src.slice(i, j)
        i = j + 1
        if (src[i] === "'") { out += "'"; i++ } else break
      }
      return decodeStepString(out)
    }
    if (src[i] === '(') {
      i++
      const list = []
      while (i < src.length && src[i] !== ')') {
        list.push(value())
        while (src[i] === ' ' || src[i] === '\n' || src[i] === '\r') i++
        if (src[i] === ',') i++
      }
      i++
      return list
    }
    let j = i
    let depth = 0
    while (j < src.length && (depth > 0 || (src[j] !== ',' && src[j] !== ')'))) {
      if (src[j] === '(') depth++
      else if (src[j] === ')') depth--
      j++
    }
    const tok = src.slice(i, j).trim()
    i = j
    return tok
  }
  const out = []
  while (i < src.length) {
    out.push(value())
    while (src[i] === ' ' || src[i] === '\n' || src[i] === '\r') i++
    if (src[i] === ',') i++
    else break
  }
  return out
}

/** STEP string escapes: \X2\....\X0\ (UTF-16 hex), \X\hh (latin-1), \S\c. */
function decodeStepString(s) {
  if (!s.includes('\\')) return s
  return s
    .replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, hex) => {
      let out = ''
      for (let k = 0; k + 4 <= hex.length; k += 4) out += String.fromCharCode(parseInt(hex.slice(k, k + 4), 16))
      return out
    })
    .replace(/\\X\\([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\S\\(.)/g, (_, c) => String.fromCharCode(c.charCodeAt(0) + 128))
}

const blank = (v) => (typeof v === 'string' && v.trim() && v.trim() !== '$' && !/^none$/i.test(v.trim()) ? v.trim() : '')

export function readStepInfo(bytes) {
  try {
    const text = new TextDecoder('latin1').decode(bytes)
    const header = {}
    const hdr = (type) => {
      const m = text.match(new RegExp(type + '\\s*\\(([\\s\\S]*?)\\);\\s*(?:\\n|\\r|FILE_|ENDSEC)'))
      return m ? stepArgs(m[1]) : null
    }
    const fn = hdr('FILE_NAME')
    if (fn) {
      if (blank(fn[1])) header['Saved'] = blank(fn[1]).replace('T', ' ').trim()
      const author = (fn[2] || []).map(blank).filter(Boolean).join(', ')
      const org = (fn[3] || []).map(blank).filter(Boolean).join(', ')
      if (author) header['Author'] = author
      if (org) header['Organisation'] = org
      if (blank(fn[4])) header['Exported by'] = blank(fn[4])
      if (blank(fn[5])) header['Originating system'] = blank(fn[5])
    }
    const fs = hdr('FILE_SCHEMA')
    if (fs) {
      const schema = String((fs[0] || [])[0] || '')
      header['STEP schema'] = /AP242|managed_model_based_3d/i.test(schema) ? 'AP242'
        : /AP214|AUTOMOTIVE_DESIGN/i.test(schema) ? 'AP214'
        : /AP203|CONFIG_CONTROL_DESIGN/i.test(schema) ? 'AP203'
        : schema.split(/\s/)[0]
    }

    // #n=TYPE(args); for the product entities only.
    const ents = new Map()
    const re = /#(\d+)\s*=\s*([A-Z_]+)\s*\(/g
    let m
    while ((m = re.exec(text))) {
      if (!PROD_TYPES.test(m[2])) continue
      // Find the closing ");" of this entity, skipping strings.
      let i = re.lastIndex, depth = 1
      while (i < text.length && depth > 0) {
        const c = text[i]
        if (c === "'") { i = text.indexOf("'", i + 1); while (text[i + 1] === "'") i = text.indexOf("'", i + 2) }
        else if (c === '(') depth++
        else if (c === ')') depth--
        i++
      }
      ents.set('#' + m[1], { id: '#' + m[1], type: m[2], args: stepArgs(text.slice(re.lastIndex, i - 1)) })
      re.lastIndex = i
    }

    const byProduct = new Map()
    for (const [id, e] of ents) if (e.type === 'PRODUCT') byProduct.set(id, { e, formations: [], categories: [] })
    for (const e of ents.values()) {
      if (e.type.startsWith('PRODUCT_DEFINITION_FORMATION')) byProduct.get(e.args[2])?.formations.push(e)
      if (e.type === 'PRODUCT_RELATED_PRODUCT_CATEGORY') for (const p of e.args[2] || []) byProduct.get(p)?.categories.push(blank(e.args[0]))
    }
    const defs = new Map()
    for (const e of ents.values()) if (e.type === 'PRODUCT_DEFINITION') defs.set(e.args[2], e)

    const products = new Map()
    for (const { e, formations, categories } of byProduct.values()) {
      const [pid, pname, pdesc] = e.args
      const props = {}
      if (blank(pid)) props['Part number'] = blank(pid)
      if (blank(pname)) props['Nomenclature'] = blank(pname)
      if (blank(pdesc)) props['Description'] = blank(pdesc)
      const f = formations[0]
      if (f) {
        if (blank(f.args[0])) props['Revision'] = blank(f.args[0])
        if (blank(f.args[1])) props['Revision note'] = blank(f.args[1])
        if (f.args[3]) props['Source'] = { '.MADE.': 'Made', '.BOUGHT.': 'Bought', '.NOT_KNOWN.': 'Not known' }[f.args[3]] || f.args[3].replace(/\./g, '')
        const d = defs.get(f.id)
        if (d && blank(d.args[1])) props['Definition'] = blank(d.args[1])
      }
      const cats = [...new Set(categories.filter(Boolean))].filter((c) => !/^(part|detail)$/i.test(c))
      if (categories.some((c) => /^assembly$/i.test(c))) props['Category'] = 'Assembly'
      else if (cats.length) props['Category'] = cats.join(', ')
      for (const key of [pname, pid].map(blank)) if (key && !products.has(key)) products.set(key, props)
    }
    return { header, products }
  } catch (e) {
    return null
  }
}

