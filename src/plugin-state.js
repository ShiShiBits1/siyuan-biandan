const PLUGIN_NAME = 'siyuan-biandan';
const STATE_FILES = new Set(['cloud-auth.json', 'pending-writes.json', 'simple-pending.json', 'attachment-settings.json', 'attachment-index.json', 'series-subplans.json']);

function sameJSON(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameJSON(left[key], right[key]));
}

/** Read raw local state without the SDK's missing-file fallback. A genuine
 * missing response is distinct from an existing malformed journal. */
export function createPluginStateReader({pluginName = PLUGIN_NAME, fetcher = globalThis.fetch} = {}) {
  if (pluginName !== PLUGIN_NAME || typeof fetcher !== 'function') throw new Error('便单本地状态读取配置无效');
  const reader = {
    async load(name) {
      if (!STATE_FILES.has(name)) throw new Error('不支持读取该便单本地状态文件');
      let response;
      try {
        response = await fetcher('/api/file/getFile', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({path: `/data/storage/petal/${pluginName}/${name}`}),
        });
      } catch {
        throw new Error('便单本地状态暂时无法读取，请稍后重试；未重置已有记录');
      }
      if (response?.status === 404) return null;
      if (!response?.ok) throw new Error('便单本地状态读取未获确认，请检查思源连接与权限；未重置已有记录');
      let value;
      try { value = await response.json(); }
      catch { throw new Error('便单本地状态内容无法解析，已保留原文件，请先核查'); }
      // SiYuan 3.8.11 returns its missing-file API envelope with HTTP 202.
      // An existing JSON file containing code:404 still returns HTTP 200 and
      // must reach the owning schema validator unchanged.
      if (response.status === 202) {
        if (value?.code === 404 && value.data === null && typeof value.msg === 'string') return null;
        throw new Error('思源未确认本地状态读取结果，已保留原文件，请先核查');
      }
      return value;
    },
    async saveChecked(name, value, saveDataCallback) {
      if (!STATE_FILES.has(name) || typeof saveDataCallback !== 'function' || value === undefined) throw new Error('便单本地状态保存配置无效');
      let intended;
      try { intended = structuredClone(value); }
      catch { throw new Error('便单本地状态无法保存，未开始后续云端写入'); }
      try { await saveDataCallback(name, structuredClone(intended)); }
      catch { throw new Error('便单本地状态暂时无法保存，已停止后续操作，请稍后重试'); }
      const stored = await reader.load(name);
      if (!sameJSON(intended, stored)) throw new Error('便单本地状态保存结果未确认，已停止后续操作，请先核查');
    },
  };
  return reader;
}
