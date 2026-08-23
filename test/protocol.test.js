import test from "node:test";
import assert from "node:assert/strict";
import { autoStopDecision } from "../protocol.js";

test("auto-stop waits for load plus network quiet",()=>{
  const session={startedAt:1000,lastNetworkAt:2500,loadFiredAt:2000};
  assert.equal(autoStopDecision(session,3500).ready,false);
  assert.deepEqual(autoStopDecision(session,4000),{active:true,ready:true,reason:"load-and-network-idle",elapsedMs:3000,quietMs:1500,loadFired:true});
});

test("auto-stop has a maximum wait for continuously active pages",()=>{
  const decision=autoStopDecision({startedAt:0,lastNetworkAt:59900,loadFiredAt:0},60000);
  assert.equal(decision.ready,true);
  assert.equal(decision.reason,"maximum-wait");
});
