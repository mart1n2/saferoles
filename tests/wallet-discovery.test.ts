import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "wagmi/actions";
import { hydrate } from "@wagmi/core";
import { createWalletConfig, disconnectWallets } from "../app/lib/wallet-config";

test("EIP-6963 exposes two independent wallets and connects the selected provider", async () => {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  const fakeWindow=new EventTarget();
  const callsA:string[]=[], callsB:string[]=[], decoy:string[]=[];
  const provider=(account:string,calls:string[])=>({
    on(){},removeListener(){},
    async request({method}:{method:string}){
      calls.push(method);
      if(method==='eth_requestAccounts'||method==='eth_accounts')return [account];
      if(method==='eth_chainId')return '0x1';
      if(method==='wallet_requestPermissions'||method==='wallet_getPermissions')return [{parentCapability:'eth_accounts'}];
      if(method==='wallet_revokePermissions')return null;
      throw new Error(`Unexpected request ${method}`);
    },
  });
  const a=provider('0x1111111111111111111111111111111111111111',callsA);
  const b=provider('0x2222222222222222222222222222222222222222',callsB);
  Object.assign(fakeWindow,{ethereum:provider('0x3333333333333333333333333333333333333333',decoy)});
  Object.defineProperty(globalThis,'window',{configurable:true,value:fakeWindow});
  const config=createWalletConfig();
  try {
    await hydrate(config,{reconnectOnMount:false}).onMount();
    for(const [index,name,rpc] of [[1,'Wallet Alpha',a],[2,'Wallet Beta',b]] as const) {
      fakeWindow.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:`00000000-0000-4000-8000-00000000000${index}`,name,rdns:`test.wallet${index}`,icon:'data:image/svg+xml,'},provider:rpc}}));
    }
    const alpha=config.connectors.find(c=>c.name==='Wallet Alpha');
    const beta=config.connectors.find(c=>c.name==='Wallet Beta');
    assert.ok(alpha);assert.ok(beta);assert.notEqual(alpha.uid,beta.uid);
    const result=await connect(config,{connector:beta});
    assert.equal(result.accounts[0].toLowerCase(),'0x2222222222222222222222222222222222222222');
    assert.equal(await beta.getProvider(),b);
    assert.ok(callsB.includes('eth_requestAccounts'));
    assert.ok(!callsA.includes('eth_requestAccounts'));
    assert.ok(!decoy.includes('eth_requestAccounts'));
    await connect(config,{connector:alpha});
    assert.equal(config.state.connections.size,2);
    assert.equal(config.state.current,alpha.uid);
    await disconnectWallets(config);
    assert.equal(config.state.status,'disconnected');
    assert.equal(config.state.connections.size,0);
    assert.equal(config.state.current,null);
  } finally {
    config._internal.mipd?.destroy();
    if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');
  }
});
