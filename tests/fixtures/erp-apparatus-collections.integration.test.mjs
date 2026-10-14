import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './erp-fixture.mjs';
import { fixtureLogin, fixtureToken, apparatusIds } from './erp-seed.mjs';
import { apparatusCollectionsPath as path } from './erp-apparatus-collections.mjs';
async function setup(scenario = 'empty') {
  const fixture = createFixture(), request = (method, url, body) => fixture.dispatch({ method, url, body, headers: { authorization: 'Bearer ' + fixtureToken } });
  await request('POST', '/v1/mobile/auth/login', fixtureLogin);
  assert.equal((await request('POST', '/__qa/apparatus-collections', { scenario })).status, 200);
  return { fixture, request };
}
test('mounted collection create/update/delete use native status, identity and revision without touching apparatus or access', async () => {
  const { fixture, request } = await setup(), before = fixture.getState().state;
  const created = await request('POST', path, { name: '  QA Group  ', apparatus_ids: [apparatusIds.print, apparatusIds.laminate] });
  assert.equal(created.status, 200); assert.equal(created.body.name, 'QA Group'); assert.equal(created.body.revision, 1); assert.match(created.body.id, /^apparatus-collection:[0-9a-f]{32}$/);
  const target = path + '/' + encodeURIComponent(created.body.id), changed = await request('PUT', target, { expected_revision: 1, name: 'QA Renamed', apparatus_ids: [] });
  assert.equal(changed.status, 200); assert.equal(changed.body.id, created.body.id); assert.equal(changed.body.revision, 2);
  assert.equal((await request('DELETE', target, { expected_revision: 1 })).status, 409);
  const removed = await request('DELETE', target, { expected_revision: 2 }); assert.deepEqual(removed, { status: 204 });
  assert.deepEqual((await request('GET', path)).body, []); assert.deepEqual(fixture.getState().state.apparatus, before.apparatus); assert.deepEqual(fixture.getState().state.roleAssignments, before.roleAssignments);
});
test('native collection membership may overlap but readonly admin cannot write', async () => {
  const { request } = await setup('collections'), collections = (await request('GET', path)).body;
  assert.equal(collections.filter(row => row.apparatus_ids.includes(apparatusIds.print)).length, 2);
  await request('POST', '/__qa/config', { capabilities: ['admin.access'] }); assert.equal((await request('GET', path)).status, 200);
  for (const [method, url, body] of [['POST', path, { name:'QA New',apparatus_ids:[] }], ['PUT',path+'/'+collections[0].id,{expected_revision:1,name:'QA Changed',apparatus_ids:[]}], ['DELETE',path+'/'+collections[0].id,{expected_revision:1}]]) assert.equal((await request(method,url,body)).status,403);
  assert.deepEqual((await request('GET', path)).body, collections);
});
test('final native revision CAS rejects a change occurring after client preflight', async () => {
  const { request } = await setup('collections'), initial = (await request('GET', path)).body[0];
  await request('POST','/__qa/apparatus-collections',{action:'concurrent',id:initial.id,patch:{name:'QA Concurrent'}});
  for (const method of ['PUT','DELETE']) {
    const body = method === 'PUT' ? {expected_revision:initial.revision,name:'QA Stale',apparatus_ids:[]} : {expected_revision:initial.revision};
    const refused = await request(method,path+'/'+initial.id,body); assert.equal(refused.status,409); assert.equal(refused.body.error,'apparatus collection revision conflict');
  }
  assert.equal((await request('GET',path)).body.find(row=>row.id===initial.id).name,'QA Concurrent');
});
test('an applied DELETE response loss has no invented receipt lookup or replay proof', async () => {
  const { fixture,request } = await setup('collections'), initial=(await request('GET',path)).body[0], nativePath=path+'/'+initial.id;
  await request('POST','/__qa/config',{rules:[{method:'DELETE',path:nativePath,once:true,dropResponse:true}]});
  const result=await request('DELETE',nativePath,{expected_revision:initial.revision}); assert.equal(result.dropResponse,true);
  assert.ok(!(await request('GET',path)).body.some(row=>row.id===initial.id)); assert.equal((await request('GET',nativePath)).status,405);
  assert.equal(fixture.getLog().filter(row=>row.method==='DELETE').length,1);
});
