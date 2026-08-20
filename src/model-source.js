// 直接从官方常量源码解析模型表 —— 这是分类数据最靠谱的来源。
//
// 为什么不只用第三方那份 freebuff-models.json：
//   * releases/latest/download 在部分网络下慢到超时（实测 >10s），一超时就回落到
//     jsdelivr 的**仓库文件**，而那份是仓库里的旧快照，可能落后好几天；
//   * 结果就是控制台显示"来源 jsdelivr"却给出过期分类。2026-08-18 上游把
//     deepseek-v4-flash 挪进 premium 池，旧表里它还是免费的 —— 差别很致命。
// 官方 raw 源是同一份数据的上游，解析它就不用等第三方生成。
import { httpJson } from './util.js';

const MIRRORS = [
  (f) => `https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/${f}`,
  (f) => `https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/${f}`,
];
const FILES = ['freebuff-models.ts', 'freebuff-model-ids.ts', 'free-agents.ts'];

// 少数 id 常量不是字面量，而是引用别处的对象成员；这里补上映射
// （worker.js 里也有同样一张 knownDefaults 表）
const KNOWN_MEMBERS = { mimoV25: 'mimo/mimo-v2.5' };

async function fetchText(file) {
  for (const build of MIRRORS) {
    const r = await httpJson(build(file), { timeoutMs: 12000, headers: { accept: 'text/plain' } });
    if (r.status === 200 && r.text && r.text.length > 200) return r.text;
  }
  return null;
}

/** export const NAME = 'x' / = OTHER / = obj.member → { NAME: 'vendor/model' } */
function parseIdConstants(src) {
  const out = {};
  for (const m of src.matchAll(/export const ([A-Z0-9_]+)\s*=\s*'([^']+)'/g)) out[m[1]] = m[2];
  // 两轮解析别名，够覆盖 A = B 这种一层引用
  for (let pass = 0; pass < 2; pass++) {
    for (const m of src.matchAll(/export const ([A-Z0-9_]+)\s*=\s*([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?\s*$/gm)) {
      const [, name, ref, member] = m;
      if (out[name]) continue;
      if (member) {
        if (KNOWN_MEMBERS[member]) out[name] = KNOWN_MEMBERS[member];
      } else if (out[ref]) {
        out[name] = out[ref];
      }
    }
  }
  return out;
}

/** 取一个数组常量的成员（常量名 + 字面量 + 展开的其它数组） */
function parseArrayConst(src, name, idMap, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const re = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`, 'm');
  const m = src.match(re);
  if (!m) return [];
  const body = m[1];
  const ids = [];
  for (const lit of body.matchAll(/'([^']+\/[^']+)'/g)) ids.push(lit[1]);
  for (const ref of body.matchAll(/\.\.\.([A-Z0-9_]+)/g)) ids.push(...parseArrayConst(src, ref[1], idMap, seen));
  for (const nm of body.matchAll(/(?:^|[\s,[])([A-Z][A-Z0-9_]{3,})\s*(?:,|$)/gm)) {
    const id = idMap[nm[1]];
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
}

/**
 * 解析每个模型块里的展示信息：
 *   const XXX_MODEL = { id: FREEBUFF_XXX_MODEL_ID, displayName: '…', availability: '…', premium: bool }
 * availability = 'off_peak_only' 的行是按时段关的（Pro 在 UTC 00:00-10:00 不可用），
 * 这种"表里有但现在调不通"的信息，正是模型列表最需要说清楚的东西。
 */
function parseModelDetails(src, idMap) {
  const out = {};
  for (const m of src.matchAll(/^const [A-Z0-9_]+_MODEL = \{([\s\S]*?)^\} as const/gm)) {
    const body = m[1];
    const idName = (body.match(/^\s*id:\s*([A-Z0-9_]+),/m) || [])[1];
    const id = idName ? idMap[idName] : null;
    if (!id) continue;
    const detail = {
      displayName: (body.match(/^\s*displayName:\s*'([^']+)'/m) || [])[1] || '',
      availability: (body.match(/^\s*availability:\s*'([^']+)'/m) || [])[1] || '',
      premium: /^\s*premium:\s*true/m.test(body),
      multimodal: /^\s*multimodal:\s*true/m.test(body),
    };
    // 关闭时段写在 availability 上面的注释里，能捞到就一起给出来
    const win = body.match(/Unavailable (\d{2}:\d{2})-(\d{2}:\d{2}) UTC/);
    if (win) detail.closedWindowUtc = `${win[1]}-${win[2]}`;
    out[id] = detail;
  }
  return out;
}

function parseNumberConst(src, name, dflt) {
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`));
  return m ? Number(m[1]) : dflt;
}

/**
 * 取一个 Record 常量里的 [常量名]: 'value' 映射。
 * free-agents.ts 里有好几张表（CLI / Web / code-reviewer …），必须指名要哪一张 ——
 * 全文瞎扫会被后面的 reviewer 表覆盖掉，agent id 就错了。
 */
function parseRecordBlock(src, name, idMap) {
  const start = src.search(new RegExp(`export const ${name}\\b`));
  if (start < 0) return new Map();
  const open = src.indexOf('{', start);
  if (open < 0) return new Map();
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (!depth) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return new Map();
  const out = new Map();
  for (const m of src.slice(open, end).matchAll(/\[([A-Z0-9_]+)\]:\s*'([^']+)'/g)) {
    const id = idMap[m[1]];
    if (id && !out.has(id)) out.set(id, m[2]);
  }
  return out;
}

/**
 * 从官方常量拉一份模型表。
 * 拿不到 / 解析结果明显不对（模型太少、没有 premium 名单）就返回 null，让调用方回落。
 */
export async function fetchOfficialTable() {
  const [modelsTs, idsTs, agentsTs] = await Promise.all(FILES.map(fetchText));
  if (!modelsTs || !agentsTs) return null;

  const src = `${modelsTs}\n${idsTs || ''}`;
  const idMap = parseIdConstants(src);
  if (Object.keys(idMap).length < 5) return null;

  // 模型全集 = CLI/桌面版那张 agent 映射表（worker 走的就是这条协议）；
  // 拿不到就退到 Web 那张
  const agents = new Map([
    ...parseRecordBlock(agentsTs, 'FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL', idMap),
    ...parseRecordBlock(agentsTs, 'FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL', idMap),
  ]);
  if (agents.size < 3) return null;

  const premium = new Set([
    ...parseArrayConst(src, 'FREEBUFF_WEB_PREMIUM_MODEL_IDS', idMap),
    ...parseArrayConst(src, 'FREEBUFF_PREMIUM_MODEL_IDS', idMap),
  ]);
  if (!premium.size) return null;

  const glm = new Set(parseArrayConst(src, 'FREEBUFF_GLM_V52_MODEL_IDS', idMap));
  if (!glm.size && idMap.FREEBUFF_GLM_V52_MODEL_ID) glm.add(idMap.FREEBUFF_GLM_V52_MODEL_ID);
  const limitedOffer = new Set(parseArrayConst(src, 'FREEBUFF_LIMITED_OFFER_MODEL_IDS', idMap));
  const deepseek = new Set(parseArrayConst(src, 'FREEBUFF_DEEPSEEK_MODEL_IDS', idMap));

  // standard = 全集 - premium - glm（官方就是这么推导 WEB_STANDARD 的）
  const standard = new Set([...agents.keys()].filter((id) => !premium.has(id) && !glm.has(id)));

  const details = parseModelDetails(modelsTs, idMap);
  return {
    models: [...agents.entries()].map(([id, agent]) => ({ id, agent, session: id, ...(details[id] || {}) })),
    details,
    pools: { premium: [...premium], standard: [...standard], glm: [...glm] },
    limits: {
      premium: parseNumberConst(src, 'FREEBUFF_PREMIUM_SESSION_LIMIT', 6),
      standard: parseNumberConst(src, 'FREEBUFF_WEB_STANDARD_SESSION_LIMIT', 6),
      deepseek: parseNumberConst(src, 'FREEBUFF_DEEPSEEK_SESSION_LIMIT', 0),
    },
    limitedOffer: [...limitedOffer],
    deepseekFamily: [...deepseek],
    generatedAt: new Date().toISOString(),
    source: 'official',
  };
}
