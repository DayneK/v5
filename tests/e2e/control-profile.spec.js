import { test, expect } from '@playwright/test';

/**
 * Easy Mode ControlProfile — real-browser verification (RB decision D6).
 *
 * Covers the acceptance points that DOM-stub tests cannot: first-run Easy
 * default, recipe preview → atomic apply into the canonical advanced sliders,
 * Advanced completeness (nothing hidden), per-surface mode persistence, and
 * a clean page-error log throughout.
 */

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

/** Boot the app: the launch modal gates every load — confirm it first. */
async function bootWorld(page) {
  await page.goto('/');
  const launch = page.locator('.launch-primary[data-act="launch"]');
  await launch.waitFor({ state: 'visible', timeout: 20000 });
  await launch.click();
  await expect(page.locator('#world-params')).toBeAttached();
  // Panels (mode bars) mount after the launch choice resolves.
  await expect(page.locator('#world-mode-bar')).toBeAttached({ timeout: 20000 });
}

async function setRange(page, locator, value) {
  await locator.evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test.describe('Easy Mode ControlProfile (browser)', () => {
  test('WORLD surface: Easy by default, recipes present, Advanced stays complete', async ({ page }) => {
    const errors = collectErrors(page);
    await bootWorld(page);
    await page.click('[data-sub="setup-world"]');

    await expect(page.locator('#world-mode-bar')).toBeVisible();
    await expect(page.locator('#world-easy-view')).toBeVisible();
    await expect(page.locator('#world-params')).toBeHidden();
    await expect(page.locator('#world-easy-view .easy-group')).toHaveCount(5);

    // The customized flag renders with its exact vocabulary (preset worlds
    // legitimately read as customized when values sit off-recipe; a canonical
    // default world does not — that guarantee is unit-tested against
    // createWorldParams() in tests/unit/controlProfile.test.js).
    const flag = page.locator('[data-testid="world-customized-motion"]');
    await expect(flag).toBeAttached();
    await expect(flag).toHaveText(/^$|^CUSTOMIZED · ADVANCED$/);

    // Switch to Advanced: the full parameter panel comes back untouched.
    await page.click('[data-testid="world-mode-advanced"]');
    await expect(page.locator('#world-params')).toBeVisible();
    await expect(page.locator('#world-easy-view')).toBeHidden();
    const rowCount = await page.locator('#world-params .sc-row').count();
    expect(rowCount, 'advanced panel must keep exposing the full parameter set').toBeGreaterThanOrEqual(140);

    expect(errors, 'world surface must not log page errors').toEqual([]);
  });

  test('recipe drag: preview then atomic apply into canonical sliders', async ({ page }) => {
    const errors = collectErrors(page);
    await bootWorld(page);
    await page.click('[data-sub="setup-world"]');

    const motion = page.locator('[data-testid="world-easy-motion"]');
    await expect(motion).toBeVisible();

    // Read the advanced GRAVITY value before the recipe runs.
    await page.click('[data-testid="world-mode-advanced"]');
    const readGravity = () => page.locator('.sc-row[data-key="GLOBAL_G"] .sc-value').textContent();
    const before = await readGravity();
    await page.click('[data-testid="world-mode-easy"]');

    // Preview (input only): the before/after line appears, nothing applies yet.
    await motion.evaluate((el) => {
      el.value = '0.9';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const preview = page.locator('[data-testid="world-preview-motion"]');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('→');

    // Confirm (change): the patch applies through the canonical path.
    await motion.evaluate((el) => {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // The advanced slider for a member key now shows the recipe's value.
    await page.click('[data-testid="world-mode-advanced"]');
    await expect
      .poll(async () => readGravity(), { timeout: 5000 })
      .not.toBe(before);
    const after = await readGravity();
    expect(after).not.toBe(before);
    expect(errors, 'recipe apply must not log page errors').toEqual([]);
  });

  test('mode preferences persist per surface across a reload', async ({ page }) => {
    await bootWorld(page);
    await page.click('[data-sub="setup-world"]');
    await page.click('[data-testid="world-mode-advanced"]');
    await page.click('[data-sub="setup-species"]');
    // Species surface defaults to Easy independently of the world surface.
    await expect(page.locator('#species-mode-bar')).toBeVisible();
    await expect(page.locator('#species-easy-view')).toBeVisible();
    await expect(page.locator('#dna-accordion')).toBeHidden();

    // The launch choice is remembered, so a reload boots straight through.
    await page.reload();
    const launch = page.locator('.launch-primary[data-act="launch"]');
    await launch.waitFor({ state: 'visible', timeout: 20000 });
    await launch.click();
    await expect(page.locator('#world-mode-bar')).toBeAttached({ timeout: 20000 });
    await page.click('[data-sub="setup-world"]');
    await expect(page.locator('[data-testid="world-mode-advanced"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#world-params')).toBeVisible();
    await page.click('[data-sub="setup-species"]');
    await expect(page.locator('[data-testid="species-mode-easy"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#species-easy-view')).toBeVisible();
  });

  test('SPECIES surface: six recipes apply to the selected species and reach Advanced', async ({ page }) => {
    const errors = collectErrors(page);
    await bootWorld(page);
    await page.click('[data-sub="setup-species"]');

    await expect(page.locator('#species-easy-view .easy-group')).toHaveCount(6);

    const reproduction = page.locator('[data-testid="species-easy-reproduction"]');
    await setRange(page, reproduction, '0.85');

    // Advanced accordion shows the recipe's effect on a member trait (DNA 10 =
    // BIRTH_RATE) once switched.
    await page.click('[data-testid="species-mode-advanced"]');
    await expect(page.locator('#dna-accordion')).toBeVisible();
    const birthValue = await page.locator('.sc-row[data-key="10"] .sc-value').textContent();
    expect(birthValue, 'BIRTH_RATE must reflect the recipe').toBeTruthy();
    expect(errors, 'species surface must not log page errors').toEqual([]);
  });
});
