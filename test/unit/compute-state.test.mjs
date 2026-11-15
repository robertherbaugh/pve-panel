import '../support/unit-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/db.js';
import { beginOperation, operationById, operationCredentials, updateOperation, priorRequest, requestHash, heldReservations, pendingOperations, completeOperation, releaseCompute, allocationFor, allocationHistory } from '../../src/compute-state.js';
const plan = { node: 'pve2', storage: 'nvme', storageKey: 'pve2/nvme', cores: 2, memoryMb: 4096, diskGb: 40, offering: { sizeId: 'medium', storageClassId: 'fast', cores: 2, memoryMb: 4096, diskGb: 40, haEnabled: false } };
let op;
test('reserves an operation and capacity before external changes, without storing plaintext credentials', () => {
  const hash = requestHash({ hostname: 'web01', password: 'very-secret-value' });
  op = beginOperation({ customerId: 1, userId: 2, vmid: 300, key: 'request_300', hash, plan, credentials: { password: 'very-secret-value' } });
  assert.equal(op.state, 'reserved'); assert.equal(heldReservations().length, 1);
  assert.ok(!JSON.stringify(op).includes('very-secret-value'));
  assert.deepEqual(operationCredentials(op.id), { password: 'very-secret-value' });
  assert.equal(priorRequest(1, 2, 'request_300', hash).id, op.id);
  assert.throws(() => priorRequest(1, 3, 'request_300', hash), /different request/);
  assert.throws(() => priorRequest(1, 2, 'request_300', requestHash({ hostname: 'other' })), /different request/);
  assert.throws(() => priorRequest(1, 2, '../bad', hash), /Idempotency-Key/);
});
test('an active operation prevents conflicting work on its VM', () => {
  assert.throws(() => beginOperation({ customerId: 1, userId: 2, vmid: 300, plan }), /holds this VM/);
  assert.equal(db.prepare('SELECT count(*) n FROM compute_operations').get().n, 1);
  updateOperation(op.id, 'cloning', { upid: 'UPID:test', taskNode: 'pve1' });
  assert.equal(pendingOperations()[0].task_node, 'pve1');
  assert.equal(pendingOperations()[0].upid, 'UPID:test');
});
test('completion records a reservation allocation once and clears temporary credentials', () => {
  completeOperation(op.id); completeOperation(op.id);
  assert.equal(operationById(op.id).state, 'complete');
  assert.deepEqual(operationCredentials(op.id), {});
  assert.equal(heldReservations()[0].state, 'committed');
  assert.equal(allocationFor(300).offering.haEnabled, false);
  assert.equal(allocationHistory(1).length, 1);
  // Power state never closes an allocation: only confirmed resource deletion does.
  assert.equal(allocationFor(300).ended_at, null);
});
test('confirmed deletion closes allocation history and releases capacity without losing the audit record', () => {
  releaseCompute(300); releaseCompute(300);
  assert.equal(heldReservations().length, 0); assert.equal(allocationFor(300), null);
  const events = allocationHistory(1);
  assert.equal(events.length, 2); assert.equal(events[0].kind, 'deleted');
  assert.ok(events[0].ended_at); assert.equal(allocationHistory(2).length, 0);
});
test('unknown outcomes retain holds and require explicit reconciliation', () => {
  const uncertain = beginOperation({ customerId: 1, userId: 2, vmid: 301, plan });
  updateOperation(uncertain.id, 'review', { error: 'Clone response lost' });
  assert.equal(heldReservations().length, 1); assert.equal(pendingOperations().length, 0);
  assert.equal(operationById(uncertain.id).error, 'Clone response lost');
  releaseCompute(301);
});
