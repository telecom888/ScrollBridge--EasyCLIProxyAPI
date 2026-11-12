// Schema migration boundary: preserve v3 data and avoid mutating on read.
// Downgrading from v4 to an old binary fails closed instead of silently dropping hosted accounts.
function migrateStore(version, config, secrets) {
  if (version === 4) return {config, secrets};
  if (version === 3) {
    return {
      config: {
        ...config,
        hostingProviders: [],
        hostingModels: [],
        showModelSources: false,
        unifiedModelRouting: false
      },
      secrets: {...secrets, hostingKeys: {}}
    };
  }
  throw new Error('不支持的配置版本');
}
module.exports = {migrateStore};
