/* npm install --prefix /tmp/shelter-demo-test jsdom
   NODE_PATH=/tmp/shelter-demo-test/node_modules node demo-tests/standalone.cjs */
const {JSDOM,VirtualConsole}=require('jsdom');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const errors=[],requests=[];let storageWrites=0;const removed=[];
 const dom=await JSDOM.fromFile(path.join(__dirname,'../shelter-demo.html'),{
  runScripts:'dangerously',resources:'usable',
  virtualConsole:new VirtualConsole().on('jsdomError',e=>errors.push(e.message)),
  beforeParse(w){
   w.fetch=()=>{requests.push('fetch');throw Error('Unexpected network request');};
   Object.defineProperty(w,'localStorage',{value:{getItem:()=>null,setItem:()=>storageWrites++,removeItem:k=>removed.push(k)}});
   w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
   w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  }
 });
 const w=dom.window,d=w.document,run=s=>w.eval(s);
 const click=s=>{assert(d.querySelector(s),'Missing element: '+s);d.querySelector(s).click();};
 const submit=id=>d.querySelector(id).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 const client=id=>{d.querySelector('#client').value=id;d.querySelector('#client').dispatchEvent(new w.Event('change',{bubbles:true}));};
 const A=run('A'),B=run('B');
 assert.equal(d.querySelector('h1').textContent,'Мост, а не хранилище');
 click('[data-role="user"]');
 assert.equal(d.querySelector('h1').textContent,'Ваш публичный ID');
 assert.equal(d.querySelector('nav [data-page="tasks"]'),null);
 assert.equal(d.querySelector('nav [data-page="updates"]'),null);
 assert.equal(d.querySelector('nav [data-page="catalog"]'),null);
 assert.throws(()=>run('requestLink(A)'),/собственным/);
 assert.throws(()=>run("requestLink('invalid')"),/формате/);
 assert.throws(()=>run("requestLink('SH-AAAA-BBBB')"),/не найден/);
 click('nav [data-page="connections"]');
 d.querySelector('[name="target"]').value=B;submit('#invite-form');
 assert.equal(run('db.links[0].status'),'pending');
 assert.throws(()=>run('acceptLink(db.links[0].id)'),/входящего/);
 assert.throws(()=>run('relay(B)'),/подтверждённой/);
 assert.throws(()=>run('requestLink(B)'),/уже существует/);
 client(B);click('[data-action="accept"]');
 assert.equal(run('db.links[0].status'),'active');
 client(A);click('nav [data-page="exchange"]');submit('#relay-form');
 assert.equal(run('db.relay.delivered'),1);
 assert.equal(run('db.relay.inflight'),0);
 assert.equal(run('db.lastDelivery.bytes'),256);
 assert.equal(run('Object.keys(db.lastDelivery).sort().join(",")'),'at,bytes,from,status,to');
 client(B);click('[data-action="presence"]');client(A);submit('#relay-form');
 assert.equal(run('db.relay.delivered'),1);
 assert.equal(run('db.relay.rejected'),2);
 assert.equal(run('db.lastDelivery'),null);
 assert.match(d.querySelector('#toast').textContent,/не сохранён/);
 client(B);click('[data-action="presence"]');
 click('nav [data-page="connections"]');click('[data-action="remove-link"]');
 client(A);assert.throws(()=>run('relay(B)'),/подтверждённой/);
 assert.equal(run('db.links.length'),0);
 click('nav [data-page="subscription"]');click('[data-action="checkout"][data-id="month"]');
 assert.equal(run('entitlement(A).active'),false);
 assert.equal(run('db.orders[0].status'),'pending');
 assert.throws(()=>run('paymentWebhook(db.orders[0].id)'),/администратора/);
 click('[data-role="admin"]');click('nav [data-page="orders"]');click('[data-action="pay"]');
 assert.equal(run('entitlement(A).active'),true);
 const expiry=run('entitlement(A).expiresAt');
 click('[data-action="replay"]');assert.equal(run('entitlement(A).expiresAt'),expiry);
 assert.equal(run('paidOrders(A).length'),1);
 run('db.verificationAvailable=false');assert.equal(run('entitlement(A).active'),false);
 run('db.verificationAvailable=true');assert.equal(run('entitlement(A).active'),true);
 // Returning a different order must not erase another paid order's entitlement.
 click('[data-role="user"]');click('nav [data-page="subscription"]');click('[data-action="checkout"][data-id="year"]');
 click('[data-role="admin"]');click('nav [data-page="orders"]');click('[data-action="pay"]');
 run("action('refund',db.orders[0].id)");submit('#modal-form');
 assert.equal(run('entitlement(A).active'),true);
 assert.equal(run('paidOrders(A).length'),1);
 for(const p of ['accounts','orders','relay','catalog','events','overview'])click(`nav [data-page="${p}"]`);
 click('nav [data-page="catalog"]');click('[data-action="release"]');
 d.querySelector('[name="version"]').value='1.5.0-beta';d.querySelector('[name="notes"]').value='test';submit('#modal-form');
 assert.equal(run('db.releases.length'),1);
 d.querySelector('[name="version"]').value='v1.5.0';submit('#modal-form');assert.equal(run('db.releases.length'),2);
 // Role visibility also enforced by operations, not only the navigation.
 click('[data-role="user"]');assert.throws(()=>run('paymentWebhook(db.orders[0].id)'),/администратора/);
 for(const p of ['account','connections','subscription','exchange'])click(`nav [data-page="${p}"]`);
 click('[data-role="admin"]');assert.throws(()=>run('requestLink(B)'),/пользователю/);
 const keys=run('Object.keys(db).join(",")');
 assert(!/tasks|boards|envelopes|queue|payload|contacts|email|name/.test(keys));
 assert(!/title|ciphertext|payload|body/.test(run('JSON.stringify(db.lastDelivery)')));
 assert.equal(storageWrites,0);assert.deepEqual(removed,['shelter:server-demo:v1']);
 assert.equal(d.querySelectorAll('script[src],link[href],img[src]').length,0);
 assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);
 console.log('PASS: file://, ID validation, consent, duplicate/self/unknown ID rejection, delivery, no queue/body, offline recipient, revocation, role guards, billing, replay idempotency, fail-closed, partial refund, numeric releases, all screens, no disk persistence/network/JS errors.');
 dom.window.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
