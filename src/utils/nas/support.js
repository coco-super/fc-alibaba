'use strict';

const { red } = require('colors');
const { parseNasUri } = require('./path');
const { getRootBaseDir } = require('../tpl/tpl');
const { findServices, isNasAutoConfig } = require('../tpl/definition');
const { convertTplToServiceNasIdMappings } = require('./nas');
const { getVersion, getNasHttpTriggerPath, getNasConfig } = require('./request');

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');

const _ = require('lodash');

function getDefaultService(tpl) {
  const services = findServices(tpl.Resources);

  if (services.length === 1) {
    return services[0].serviceName;
  }
  throw new Error(red('There should be one and only one service in your template.[yml|yaml] when ignoring service in nas path.'));
}
function chunk(arr, size) {
  if (size < 1) {
    throw new Error('chunk step should not be 0');
  }
  return Array(Math.ceil(arr.length / size)).fill().map((_, i) => arr.slice(i * size, i * size + size));
}

function splitRangeBySize(start, end, chunkSize) {
  if (chunkSize === 0) {
    throw new Error('chunkSize of function splitRangeBySize should not be 0');
  }
  const res = [];
  while (start < end) {
    const size = Math.min(chunkSize, end - start);
    res.push({
      start,
      size
    });
    start = start + size;
  }
  return res;
}
// 检查nasId 是否有 nasPath 的写权限
// 返回相关字符串信息,undefined 表示有权限，否则无权限且返回相应 tip
function checkWritePerm(stats, nasId, nasPath) {
  if (!stats.exists) {
    return undefined;
  }
  const userId = nasId.UserId;
  const groupId = nasId.GroupId;

  const mode = stats.mode;
  const nasPathUserId = stats.UserId;
  const nasPathGroupId = stats.GroupId;
  if (nasPathUserId === 0 && nasPathGroupId === 0) {
    return undefined;
  }

  // permStirng 为 ‘777’ 形式的权限形式

  let permString = (mode & parseInt('777', 8)).toString(8);
  const [ ownerCanWrite, groupCanWrite, otherCanWrite ] = _.map(permString, (perm) => hasWritePerm(parseInt(perm), stats, nasPath));

  if (!ownerCanWrite && !groupCanWrite && !otherCanWrite) {

    return `${nasPath} has no '-w-' or '-wx' permission, more information please refer to https://github.com/alibaba/funcraft/blob/master/docs/usage/faq-zh.md`;
  } else if (ownerCanWrite && groupCanWrite && otherCanWrite) {

    return undefined;
  } else if ((userId === nasPathUserId && !ownerCanWrite) && (groupId === nasPathGroupId && !groupCanWrite) && otherCanWrite) {

    return `UserId: ${nasPathUserId} and GroupId: ${nasPathGroupId} have no '-w-' or '-wx' permission to ${nasPath}, which may cause permission problem, \
more information please refer to https://github.com/alibaba/funcraft/blob/master/docs/usage/faq-zh.md`;
  } else if (!( (userId === nasPathUserId && ownerCanWrite) || (groupId === nasPathGroupId && groupCanWrite) )) {

    return `UserId: ${userId} and GroupId: ${groupId} in your NasConfig are mismatched with UserId: ${nasPathUserId} and GroupId: ${nasPathGroupId} of ${nasPath}, \
which may cause permission problem, more information please refer to https://github.com/alibaba/funcraft/blob/master/docs/usage/faq-zh.md`;
  }
  return undefined;
}
function hasWritePerm(num, stats, nasPath) {
  if (stats.isDir && !stats.isFile) {
    // -wx, num | 100 === 7
    return ((num | 4) === 7);
  } else if (stats.isFile && !stats.isDir) {
    // -w-, num | 101
    return ((num | 5) === 7);
  } else if (stats.isFile && stats.isDir) {
    throw new Error(`isFile and isDir attributes of ${nasPath} are true simultaneously`);
  }
}

async function isNasServerStale(serviceName, nasConfig, version) {

  return !(await isSameVersion(serviceName, version) && await isSameNasConfig(serviceName, nasConfig));
}

async function isSameVersion(serviceName, version) {
  const nasHttpTriggerPath = getNasHttpTriggerPath(serviceName);
  let getVersionRes;
  let curNasServerVersion;
  try {
    getVersionRes = await getVersion(nasHttpTriggerPath);
    curNasServerVersion = (getVersionRes.data).curVersionId;
  } catch (error) {
    curNasServerVersion = -1;
  }

  return _.isEqual(curNasServerVersion, version);
}

async function isSameNasConfig(serviceName, nasConfig) {
  let curNasServerNasConfig;
  try {
    curNasServerNasConfig = await getNasConfig(serviceName);
    curNasServerNasConfig = {
      UserId: curNasServerNasConfig.userId,
      GroupId: curNasServerNasConfig.groupId,
      MountPoints: curNasServerNasConfig.mountPoints.map(p => ({ ServerAddr: p.serverAddr, MountDir: p.mountDir }))
    };
  } catch (error) {
    curNasServerNasConfig = {};
  }

  if (isNasAutoConfig(nasConfig)) {
    // 当线上函数计算端的 NasConfig 包含如下几个选项时，对应本地 NasConfig: Auto
    // UserId: 10003,
    // GroupId: 10003,
    // MountDir: /mnt/auto
    // 当本地 NasConfig 为 Auto 时，认为 nas 配置未变
    return _.isEqual(curNasServerNasConfig.UserId, nasConfig.UserId || 10003) &&
          _.isEqual(curNasServerNasConfig.GroupId, nasConfig.GroupId || 10003) &&
          _.isEqual(curNasServerNasConfig.MountPoints[0].MountDir, '/mnt/auto');
  }
  return _.isEqual(nasConfig, curNasServerNasConfig);
}

function toBeUmountedDirs(configuredMountDirs, mountedDirs) {

  const toUnmountDirs = mountedDirs.filter((mountedDir) => !configuredMountDirs.includes(mountedDir));

  return toUnmountDirs;
}

function getNasId(tpl, serviceName) {
  const serviceNasIdMappings = convertTplToServiceNasIdMappings(tpl);
  return serviceNasIdMappings[serviceName];
}

function getNasPathAndServiceFromNasUri(nasUri, tpl) {
  var { nasPath, serviceName } = parseNasUri(nasUri);
  // 此时 nasDir 的格式应为 nas://${ serviceName }${ mountDir }
  if (serviceName === '') {
    serviceName = getDefaultService(tpl);
  }
  return { nasPath, serviceName };
}

async function readFileFromNasYml(nasYmlPath) {

  if (!await fs.pathExists(nasYmlPath)) {
    return {};
  }
  const contentStr = await fs.readFile(nasYmlPath, 'utf8');

  if (!contentStr) { return {}; }

  let contentObj;

  try {
    contentObj = yaml.safeLoad(contentStr, {
      schema: yaml.JSON_SCHEMA
    });
  } catch (e) {
    throw new Error(`\nThere was a problem with parsing ${nasYmlPath}. Ensure it is valid YAML!
${e}

After .nas.yml is configured correctly. You may be able to redeploy resources by following two steps:

1. Execute 'fun nas sync' to upload local NAS resources to the NAS service.
2. Execute ‘fun deploy’ to deploy resources to function computer.
`);
  }

  return contentObj || {};
}

async function getNasMappingsFromNasYml(nasYmlPath) {
  const contentObj = await readFileFromNasYml(nasYmlPath);
  return contentObj.nasMappings || {};
}

async function extractNasMappingsFromNasYml(baseDir, serviceName) {
  const rootBaseDir = getRootBaseDir(baseDir);
  const nasYmlPath = path.join(rootBaseDir, '.nas.yml');

  const content = await getNasMappingsFromNasYml(nasYmlPath);

  if (_.isEmpty(content)) {
    return [];
  }
  if (_.isEmpty(content[serviceName])) {
    return [];
  }
  return content[serviceName];
}

async function generateIgnoreFileFromNasYml(baseDir) {

  const rootBaseDir = getRootBaseDir(baseDir);
  const nasYmlPath = path.join(rootBaseDir, '.nas.yml');

  const content = await getNasMappingsFromNasYml(nasYmlPath);

  if (_.isEmpty(content)) { return []; }

  const ignoreList = [];

  _.forEach(content, (nasMappings, key) => {
    for (const nasMapping of nasMappings) {
      const ignore = path.relative(baseDir, nasMapping.localNasDir);
      ignoreList.push(ignore.split(path.sep).join('/'));
    }
  });

  return _.uniq(ignoreList);
}

async function mergeNasMappingsInNasYml(nasYmlPath, serviceNasMappings) {
  // read from .nas.yml
  const nasMappingsInNasYml = await getNasMappingsFromNasYml(nasYmlPath);

  const customizer = (objValue, srcValue) => {
    if (objValue) {
      const isEqualCustomizer = (objValue, othValue) => {
        // 这里判断 nasMappings 里的 localNasDir 要严格相等：绝对路径相同（存在相对路径的情况)
        const strictEqual = (path.resolve(objValue.localNasDir) === path.resolve(othValue.localNasDir)) && (objValue.remoteNasDir === othValue.remoteNasDir);
        return strictEqual;
      };
      return _.uniqWith([...objValue, ...srcValue], isEqualCustomizer);
    }
    return srcValue;
  };

  return _.mergeWith(serviceNasMappings, nasMappingsInNasYml, customizer);
}

module.exports = {
  getDefaultService,
  chunk,
  splitRangeBySize,
  checkWritePerm,
  isNasServerStale,
  toBeUmountedDirs,
  isSameNasConfig,
  isSameVersion,
  getNasId,
  getNasPathAndServiceFromNasUri,
  getNasMappingsFromNasYml,
  generateIgnoreFileFromNasYml,
  extractNasMappingsFromNasYml,
  mergeNasMappingsInNasYml,
  readFileFromNasYml
};
