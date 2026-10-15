/* Synthetic DOM regression cases, without opening a real mailbox. */
const {chromium}=require('playwright');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.MW_BROWSER_PATH||'/Users/xingdawang/Library/Caches/ms-playwright/chromium-1117/chrome-mac/Chromium.app/Contents/MacOS/Chromium',headless:true});const page=await browser.newPage();
const row='<div role="listbox"><div role="option" aria-selected="false" data-convid="one"><span title="conversations@mail.etsy.com">Etsy</span><span>Etsy Conversation with Alice</span></div></div>';
async function read(html,url){await page.setContent(html);await page.addScriptTag({path:path.resolve(__dirname,'../core.js')});await page.addScriptTag({path:path.resolve(__dirname,'../adapters.js')});return page.evaluate(u=>MailWatchAdapters.read(document,u),url);}
const tree=(name='收件匣',account='SHOP@outlook.com')=>`<div role="tree"><div role="treeitem" aria-expanded="true" title="${account}"><span>SHOP@outl…</span><div role="group"><div role="treeitem" aria-selected="true" aria-label="${name} 576">${name}</div></div></div></div>`;
let report=await read(tree()+row,'https://outlook.live.com/mail/?culture=zh-cn&country=cn');assert.equal(report.email,'shop@outlook.com');assert.equal(report.status,'limited');assert.equal(report.messages.length,1);
report=await read(tree('收件箱')+row,'https://outlook.live.com/mail/0/');assert.equal(report.status,'limited');
report=await read(tree('Inbox')+row,'https://outlook.live.com/mail/inbox');assert.equal(report.status,'limited');
report=await read(tree('寄件備份')+row,'https://outlook.live.com/mail/?culture=zh-cn');assert.equal(report.status,'wrong_folder');assert.equal(report.messages.length,0);
report=await read(tree()+row,'https://outlook.live.com/mail/?q=etsy');assert.equal(report.status,'wrong_folder');
report=await read(row,'https://outlook.live.com/mail/0/inbox');assert.equal(report.email,'');assert.equal(report.status,'identity_unknown'); // Sender address is not the owner.
report=await read(tree('收件箱','SHOP@outl…')+row,'https://outlook.live.com/mail/');assert.equal(report.email,'');assert.equal(report.status,'identity_unknown');
report=await read('<button id="O365_MainLink_Me" aria-label="账户管理器"></button><div id="mectrl_currentAccount_secondary">shop@outlook.com</div>'+tree('收件匣','SHOP@outl…')+row,'https://outlook.live.com/mail/?culture=zh-cn');assert.equal(report.email,'shop@outlook.com');assert.equal(report.status,'limited');assert.equal(report.identityToken,''); // A generic avatar label is not account identity.
report=await read('<div role="tree"><div role="treeitem" aria-expanded="true" title="a@outlook.com">A</div><div role="treeitem" aria-expanded="true" title="b@outlook.com">B</div><div role="treeitem" aria-selected="true">收件箱</div></div>'+row,'https://outlook.live.com/mail/');assert.equal(report.email,'');
report=await read(tree()+row,'https://outlook.live.com/mail/0/sentitems');assert.equal(report.status,'wrong_folder');
await browser.close();console.log('Outlook adapter: 10 DOM cases PASS (default/localized inbox, account headings, avatar, truncated and ambiguous identity, non-inbox/search rejection)');})().catch(e=>{console.error(e);process.exit(1)});
