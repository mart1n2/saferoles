# Bot 以 role 身份发交易

Bot 不是 Safe 签名人，不收集签名，也不经过 Safe Transaction Service。它用自己的 EOA 调用
Roles Modifier 的 `execTransactionWithRole`：Modifier 按 role 的规则检查这笔调用，通过后让
Safe 执行，不通过就整笔 revert。对链来说，这只是一个 EOA 发出的普通合约调用，所以用 viem
就够了；`zodiac-roles-sdk` 提供 ABI（`rolesAbi`）和 role key 编码（`encodeKey`）。

| 文件 | 作用 |
| --- | --- |
| `roles-exec.ts` | 可复用的部分：把调用包装成 role 交易、MultiSend 批量编码、先模拟再发送、把 Modifier 的 revert 解码成可读原因 |
| `send.ts` | 示例 bot 动作：给 `SPENDER` 授权 `TOKEN`。默认只模拟，加 `--send` 才广播 |
| `setup-fork.ts` | 在本地 anvil fork 上搭一套 Safe + Roles + bot role，方便直接跑 `send.ts` |

## 在本地 fork 上跑一遍

```bash
anvil --fork-url https://base-rpc.publicnode.com
```

```bash
npx tsx examples/bot-send/setup-fork.ts > /tmp/bot-env.sh && source /tmp/bot-env.sh
```

`setup-fork.ts` 会部署一个新 Safe（默认 1.4.1，可用 `SAFE_VERSION` 选 1.3.0 / 1.5.0）和 Roles Modifier（官方 mastercopy，owner = avatar = target = Safe），
启用模块，设置 MultiSend unwrapper，并给一个临时生成的 bot key 分配 role `bot-demo`：只能对 WETH 调
`approve`，且 spender 必须是 Aave v3 Pool。Safe 的 owner 操作是通过 anvil 冒充 Safe 地址完成的，
只在本地 fork 上可行；真实链上这些步骤是 Safe 提案，由签名人在 SafeRoles 里提交。

```bash
npx tsx examples/bot-send/send.ts                  # 模拟：通过
npx tsx examples/bot-send/send.ts --send           # 发送单笔 approve
npx tsx examples/bot-send/send.ts --batch --send   # MultiSend：先 approve 0，再 approve AMOUNT
SPENDER=0x000000000000000000000000000000000000dEaD npx tsx examples/bot-send/send.ts
# refused  Role check failed: ParameterNotAllowed (...)
```

## 用在真实的 Modifier 上

| 环境变量 | 含义 |
| --- | --- |
| `RPC_URL` | 链的 RPC |
| `BOT_PRIVATE_KEY` | bot（role 成员）的私钥 |
| `ROLES_MOD` | Roles Modifier 地址 |
| `ROLE` | role 名（如 `usdc-yield`），或 bytes32 key |
| `TOKEN` / `SPENDER` / `AMOUNT` | 示例动作的参数，`AMOUNT` 为最小单位 |
| `MULTISEND` | 可选，批量交易用的合约，默认 MultiSendCallOnly 1.4.1。必须是 Modifier 上登记了 unwrapper 的地址 |

先不加 `--send` 跑一次。模拟失败时，输出会给出 Modifier 拒绝的原因：

| 输出 | 含义 |
| --- | --- |
| `NotAuthorized` | bot 不是该 role 的成员 |
| `TargetAddressNotAllowed` / `FunctionNotAllowed` | 合约或函数不在白名单里（`info` 是目标地址或 selector）。如果是批量交易报 `TargetAddressNotAllowed`，先检查 `MULTISEND` 地址在 Modifier 上有没有 unwrapper |
| `ParameterNotAllowed` 等 | 参数不满足条件 |
| `AllowanceExceeded` | 本周期额度用完了 |
| `ModuleTransactionFailed` | 权限检查通过，但调用本身在 Safe 里 revert 了 |

## 批量交易

多笔调用会被编码成对 MultiSendCallOnly 的 delegatecall（默认 1.4.1，可用 `MULTISEND` 换成别的地址）。
Modifier 用 unwrapper 拆开，逐笔按 role 检查，任意一笔不通过整个 batch revert。用 call-only 版本是为了
内部调用不可能是 delegatecall。

### 不同 Safe 版本

MultiSend 的版本不需要和 Safe 的版本一致。MultiSend 是一个无状态的库合约，由 Safe delegatecall
执行；各版本的批量编码格式相同。Bot 也从不直接调用 Safe，只调用 Modifier；Modifier 对每个版本的 Safe
都通过 `execTransactionFromModule` 执行。

真正要对上的是 **Modifier 上注册了 unwrapper 的那个地址**。unwrapper 是按批量合约地址登记的，bot
发往没有登记的地址时，整笔会被拒绝，报 `TargetAddressNotAllowed`。SafeRoles 给新建的 Modifier 登记的是
1.4.1 的 MultiSend 和 MultiSendCallOnly，所以 bot 默认用 1.4.1，不管 Safe 是哪个版本。

| MultiSendCallOnly | 地址（canonical） |
| --- | --- |
| 1.3.0 | `0x40A2aCCbd92BCA938b02010E17A5b8929b49130D` |
| 1.4.1 | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` |
| 1.5.0 | `0xA83c336B20401Af773B6219BA5027174338D1836` |

1.3.0 在部分链上用的是 `eip155` 部署地址，zkSync 上各版本的地址也不同，具体以
[safe-deployments](https://github.com/safe-global/safe-deployments) 为准。

Safe 1.5.0 新增了 module guard（`setModuleGuard`）。如果 Safe 设置了 module guard，Roles 发起的模块交易
（包括对 MultiSend 的 delegatecall）也要经过它的检查，可能被拦下。

在 fork 上测过 3 × 3 组合：Safe 1.3.0 / 1.4.1 / 1.5.0，分别配 MultiSendCallOnly 1.3.0 / 1.4.1 / 1.5.0。
每组单笔、批量都成功，越权的批量都被拒绝。可以这样复现某一组：

```bash
SAFE_VERSION=1.5.0 MULTISEND=0xA83c336B20401Af773B6219BA5027174338D1836 npx tsx examples/bot-send/setup-fork.ts > /tmp/bot-env.sh && source /tmp/bot-env.sh
```

## 示例没覆盖、生产 bot 需要自己补的

- **私钥托管**：用 KMS / HSM 签名，不要把私钥放在环境变量里。viem 的 `toAccount` 可以包装任意签名器。
- **nonce 和 gas**：示例交给 viem 自动处理。并发发送、交易卡住后的替换（同 nonce 提高 gas）需要自己管。
- **模拟到上链之间的状态变化**：模拟通过不代表上链一定成功（比如额度在这期间被用掉）。`sendWithRole`
  会检查 receipt 状态，失败时抛错，调用方应记录并告警。
- **监控和应急**：监控 allowance 余量和失败率；准备好由多签调用 `assignRoles` 撤销成员的流程。
- **权限本身**：示例的 role 把 spender 固定为单一地址。真实 role 里，收款方、`onBehalfOf` 这类参数都应固定为
  Safe 或已知地址，不要用不带条件的 `allowFunction`。
