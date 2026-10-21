const path = require('node:path');
function dataDirectory({testDirectory,portableFile,packaged,executable,appPath}) {
  if(testDirectory)return path.resolve(testDirectory);
  return portableFile ? path.dirname(path.resolve(portableFile)) : packaged ? path.dirname(executable) : appPath;
}
module.exports = {dataDirectory};
