/* Synthetic Gmail conversation regression cases; never contacts a mailbox. */
const {chromium}=require('playwright');
const path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.MW_BROWSER_PATH||'/Users/xingdawang/Library/Caches/ms-playwright/chromium-1117/chrome-mac/Chromium.app/Contents/MacOS/Chromium',headless:true});
  try {
    const page=await browser.newPage();
    const fixture=`<a href="https://accounts.google.com/SignOutOptions" aria-label="Google Account: Owner (observed@gmail.com)">Owner</a><main role="main"><table><tbody><tr class="zA" data-legacy-message-id="original" data-legacy-last-message-id="latest-1" data-legacy-thread-id="same-thread"><td class="yW"><span email="no-reply@account.etsy.com">Etsy</span><span class="bsU">2</span></td><td><span class="bog">Etsy Conversation with Alice</span></td><td class="xW"><span title="2026-10-16T12:00:00Z">Now</span></td></tr></tbody></table></main>`;
    await page.route("https://gmail.fixture.test/**",route=>route.fulfill({contentType:"text/html",body:fixture}));
    await page.goto("https://gmail.fixture.test/");
    for(const file of ['core.js','adapters.js'])await page.addScriptTag({path:path.resolve(__dirname,'../'+file)});
    const result=await page.evaluate(async()=>{
      const C=MailWatchCore,url='https://mail.google.com/mail/u/0/#inbox',tab={id:1,url},now=Date.parse('2026-10-16T12:00:00Z');
      const state=C.createState(now);state.connection={status:'connected',owner:'owner',token:'test',recordedEmail:'configured@gmail.com'};
      const read=()=>MailWatchAdapters.read(document,url);
      const first=read();await C.applySnapshot(state,tab,first,now);
      document.querySelector('tr').setAttribute('data-legacy-last-message-id','latest-2');
      const second=read();const added=await C.applySnapshot(state,tab,second,now+1000);
      const repeated=await C.applySnapshot(state,tab,read(),now+2000);
      document.querySelector('tr').classList.add('zE');
      const unread=await C.applySnapshot(state,tab,read(),now+3000);
      // Latest ID may be on a descendant while original ID remains on the row.
      document.querySelector('tr').removeAttribute('data-legacy-last-message-id');
      document.querySelector('.bog').setAttribute('data-legacy-last-message-id','latest-child');
      const nested=read().messages[0];
      document.querySelector('.bog').removeAttribute('data-legacy-last-message-id');
      const fallback=read();await C.applySnapshot(state,tab,fallback,now+4000);
      document.querySelector('.bsU').textContent='3';
      const countAdded=await C.applySnapshot(state,tab,read(),now+5000);
      const countRepeated=await C.applySnapshot(state,tab,read(),now+6000);
      return {first:first.messages[0],second:second.messages[0],added,repeated,unread,nested,fallback:fallback.messages[0],countAdded,countRepeated};
    });
    assert.equal(result.first.sourceId,'latest-1');assert.equal(result.second.sourceId,'latest-2');
    assert.equal(result.added.length,1);assert.equal(result.added[0].email,'configured@gmail.com');
    assert.equal(result.repeated.length,0);assert.equal(result.unread.length,0);
    assert.equal(result.nested.sourceId,'latest-child');assert.equal(result.nested.identityKind,'message');
    assert.equal(result.fallback.sourceId,'same-thread');assert.equal(result.fallback.identityKind,'thread');
    assert.equal(result.countAdded.length,1);assert.equal(result.countRepeated.length,0);
    console.log('Gmail DOM regression PASS: appended messages, nested latest ID, count fallback, repeated/unread scans, central attribution');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
