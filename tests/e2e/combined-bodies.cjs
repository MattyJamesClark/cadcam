// Regression: combining bodies and editing faces must never lose a body.
// (Box + cylinder, Add, then Edit faces on the cylinder used to delete the box.)
// Run after `npm run build`:  node tests/e2e/combined-bodies.cjs   (needs Playwright and a display)
const path = require('path')
const assert = require('assert')
const { _electron } = require('playwright')

const root = path.resolve(__dirname, '../..')

async function start() {
  const app = await _electron.launch({ executablePath: require('electron'), args: [root, '--no-sandbox'] })
  const w = await app.firstWindow()
  await w.setViewportSize({ width: 1500, height: 900 })
  const errs = []
  w.on('pageerror', (e) => errs.push(e.message))
  await w.waitForSelector('.tree')
  await w.click('.tab:has-text("Home")')
  await w.locator('.cmd:has-text("Box")').first().click()
  await w.waitForTimeout(1500)
  await w.locator('.cmd:has-text("Cylinder")').first().click()
  await w.waitForTimeout(1500)
  return { app, w, errs }
}

// Bodies in the model tree.
const bodyCount = (w) => w.locator('.tree li.tree-item.kind-body:visible').count()

async function add(w, target, tool) {
  await w.click('.tab:has-text("Part Design")')
  await w.click('[data-cmd="part.add"]')
  await w.waitForTimeout(300)
  await w.mouse.click(...target)
  await w.waitForTimeout(300)
  await w.mouse.click(...tool)
  await w.waitForTimeout(3000)
  await w.keyboard.press('Enter')
  await w.waitForTimeout(1500)
}

async function editFace(w, at, d) {
  await w.mouse.move(...at)
  await w.waitForTimeout(200)
  await w.mouse.click(...at, { button: 'right' })
  await w.waitForTimeout(300)
  await w.click('.ctx-menu .menu-item:has-text("Edit face")', { timeout: 3000 })
  await w.waitForTimeout(300)
  await w.fill('.editfaces-strip input', String(d))
  await w.waitForTimeout(4000)
  const prompt = await w.textContent('.vp-prompt')
  await w.keyboard.press('Enter')
  await w.waitForTimeout(1500)
  if (await w.locator('.editfaces-strip').count()) await w.keyboard.press('Escape')
  return prompt
}

;(async () => {
  // 1. Bodies that don't touch: Add keeps both solids (as two bodies), and editing one leaves the other.
  {
    const { app, w, errs } = await start()
    await add(w, [760, 500], [1020, 620])
    assert.strictEqual(await bodyCount(w), 2, 'Add of separate bodies must keep both')
    await editFace(w, [1020, 480], 10)
    assert.strictEqual(await bodyCount(w), 2, 'Edit faces must not remove the other body')
    assert.deepStrictEqual(errs, [])
    await app.close()
  }
  // 2. Overlapping box + cylinder: Add makes one body; editing the cylinder's top and side faces keeps it whole.
  {
    const { app, w, errs } = await start()
    await w.click('.tree :text("Cylinder 2")')
    await w.locator('.cmd:has-text("Translate")').first().click()
    await w.waitForTimeout(400)
    await w.fill('.translate-strip .vs-field.axis-x input', '-40')
    await w.keyboard.press('Enter')
    await w.waitForTimeout(500)
    await add(w, [700, 500], [930, 620])
    assert.strictEqual(await bodyCount(w), 1, 'overlapping Add makes one body')
    const top = await editFace(w, [890, 455], 10)
    assert.match(top, /Out 10 mm/, 'top face edit should preview')
    assert.strictEqual(await bodyCount(w), 1)
    await w.keyboard.press('Control+z')
    await w.waitForTimeout(500)
    const side = await editFace(w, [985, 600], 5)
    assert.doesNotMatch(side, /removed part|empty body|broken/, `side face edit failed: ${side}`)
    assert.strictEqual(await bodyCount(w), 1, 'the box must still be there')
    assert.deepStrictEqual(errs, [])
    await app.close()
  }
  console.log('combined-bodies: ok')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
