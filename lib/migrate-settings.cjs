const {validateConfig,validateAccessKey}=require('./config.cjs');
const {newKey,syncModels}=require('./policy.cjs');
function convert(data,secrets) {
  if(data.version!==1 || !data.config)throw new Error('源文件不是旧版配置');
  // A downgraded writer may leave newer encrypted entries behind. Do not
  // discard these credentials or guess their lost permissions.
  if(secrets.keyValues)throw new Error('旧配置包含新版密钥记录，请从新版配置备份恢复，未生成新密钥');
  validateAccessKey(secrets.accessKey);
  const key=newKey();
  const config=validateConfig(syncModels({...data.config,accessKeys:[key],diagnosticKeyId:key.id,modelRules:[]},data.config.knownModels || []));
  return{config,secrets:{upstreamKey:secrets.upstreamKey || '',tunnelToken:secrets.tunnelToken || '',keyValues:{[key.id]:secrets.accessKey}}};
}
module.exports={convert};
