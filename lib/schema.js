/**
 * lib/schema.js — 把上游的 author 参数表翻成标准 JSON Schema。
 *
 * 上游（`src/storyboard/tool-spec.js`）用 author 格式描述参数：每个属性上写
 * `required: true`，由宿主的 defineTool 提到父级 `required` 数组。天枢的 TPI 2.0
 * 直接把 `inputSchema` 当 JSON Schema 用，没有这层编译，所以这一段搬到了插件里。
 *
 * 规则逐条照抄上游 `src/define-tool.js` 的 compilePropertyMap：
 *   - 属性上的 `required: true` 提升到父级 required 数组，并从属性里删掉；
 *   - `type: 'json'` 是 author-only 节点 → 退化成 `{}`（只保留 description 等注解）；
 *   - `properties` / `items` 递归；其余键（description / enum / additionalProperties）原样透传。
 */

function compileValue(spec, path) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${path} 必须是对象`);
  }
  const out = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'required') continue;
    if (key === 'properties') {
      const compiled = compilePropertyMap(value, `${path}.properties`);
      out.properties = compiled.properties;
      if (compiled.required) out.required = compiled.required;
      continue;
    }
    if (key === 'items') {
      out.items = compileValue(value, `${path}.items`);
      continue;
    }
    if (key === 'type' && value === 'json') continue;
    out[key] = value;
  }
  return out;
}

function compilePropertyMap(map, path) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(map)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`${path}.${key} 必须是对象`);
    }
    const { required: mark, ...rest } = spec;
    if (mark === true) required.push(key);
    properties[key] = compileValue(rest, `${path}.${key}`);
  }
  return required.length > 0 ? { properties, required } : { properties };
}

/** 参数表 → JSON Schema（object）。 */
export function parametersToJsonSchema(parameters = {}) {
  const { properties, required } = compilePropertyMap(parameters, 'parameters');
  return { type: 'object', properties, ...(required ? { required } : {}) };
}
