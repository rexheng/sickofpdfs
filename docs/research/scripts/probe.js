// usage: node probe.js <config.json>
// config: {url, out (prefix), width, height, scale, wait, steps:[{type:'click'|'dblclick'|'hover'|'rightclick'|'wait'|'shot'|'dump'|'key'|'clicksel'|'eval', x,y, ms, name, sel, key, js}]}
const { chromium } = require('playwright');
const fs = require('fs');
const DUMP_JS = () => {
  const props = ['font-family','font-size','font-weight','line-height','letter-spacing','color','background-color','background-image','border-radius','box-shadow','border-top','border-bottom','border-left','border-right','padding','margin','opacity','font-variation-settings','font-feature-settings','height','width','outline','fill','text-transform','gap','backdrop-filter','z-index','position'];
  const out = [];
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
    own = own.trim().replace(/\s+/g,' ').slice(0,60);
    const o = { tag: el.tagName.toLowerCase(), cls: (typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '').slice(0,80), id: el.id || undefined,
      role: el.getAttribute('role') || undefined, aria: (el.getAttribute('aria-label')||'').slice(0,60) || undefined, dataTooltip: el.getAttribute('data-tooltip') || undefined,
      text: own || undefined, x: Math.round(r.left*10)/10, y: Math.round(r.top*10)/10, w: Math.round(r.width*10)/10, h: Math.round(r.height*10)/10, s: {} };
    for (const p of props) o.s[p] = cs.getPropertyValue(p);
    out.push(o);
  }
  return out;
};
(async () => {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const browser = await chromium.launch({ proxy: { server: 'http://127.0.0.1:44837' }, ...(cfg.channel ? {channel: cfg.channel} : {}), ...(cfg.headless === false ? {headless:false} : {}) });
  const ctx = await browser.newContext({ viewport: { width: cfg.width||1440, height: cfg.height||900 }, deviceScaleFactor: cfg.scale||2, locale: 'en-US', timezoneId: 'America/Los_Angeles', colorScheme: cfg.colorScheme || 'light',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  const cssUrls = [];
  page.on('requestfailed', r => console.log('REQFAIL', r.url().slice(0,150), r.failure() && r.failure().errorText)); page.on('response', r => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url().slice(0,3000));  const ct = r.headers()['content-type']||''; if (ct.includes('css') || ct.includes('font') ) cssUrls.push(r.url()); });
  const resp = await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('status', resp && resp.status(), page.url());
  await page.waitForTimeout(cfg.wait || 6000);
  for (const st of (cfg.steps||[])) {
    try {
      if (st.type === 'click') await page.mouse.click(st.x, st.y);
      else if (st.type === 'dblclick') await page.mouse.dblclick(st.x, st.y);
      else if (st.type === 'rightclick') await page.mouse.click(st.x, st.y, { button: 'right' });
      else if (st.type === 'hover') await page.mouse.move(st.x, st.y);
      else if (st.type === 'wheel') { await page.mouse.move(st.x, st.y); await page.mouse.wheel(0, st.dy); }
      else if (st.type === 'wait') await page.waitForTimeout(st.ms);
      else if (st.type === 'key') await page.keyboard.press(st.key);
      else if (st.type === 'clicksel') await page.click(st.sel, { timeout: 10000 });
      else if (st.type === 'eval') console.log('eval', JSON.stringify(await page.evaluate(st.js)).slice(0, 4000));
      else if (st.type === 'shot') { await page.screenshot({ path: cfg.out + '_' + st.name + '.png', fullPage: !!st.full }); console.log('shot', st.name); }
      else if (st.type === 'dump') { const d = await page.evaluate(DUMP_JS); fs.writeFileSync(cfg.out + '_' + st.name + '.json', JSON.stringify(d)); console.log('dump', st.name, d.length); }
      else if (st.type === 'dumpframes') { let all = []; for (const f of page.frames()) { try { let off = {x:0,y:0}; const fe = await f.frameElement().catch(()=>null); if (fe) { const bb = await fe.boundingBox(); if (!bb) continue; off = bb; } const d = await f.evaluate(DUMP_JS); for (const e of d) { e.frame = f.url().slice(0,100); e.x += off.x; e.y += off.y; } all = all.concat(d); console.log('frame', f.url().slice(0,100), d.length, JSON.stringify(off)); } catch (e) { console.log('frame err', e.message.slice(0,100)); } } fs.writeFileSync(cfg.out + '_' + st.name + '.json', JSON.stringify(all)); }
      else if (st.type === 'html') { fs.writeFileSync(cfg.out + '_' + st.name + '.html', await page.content()); }
    } catch (e) { console.log('step error', st.type, st.name || '', e.message.slice(0,200)); }
  }
  fs.writeFileSync(cfg.out + '_resources.txt', cssUrls.join('\n'));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
