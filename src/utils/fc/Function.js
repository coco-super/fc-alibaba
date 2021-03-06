const fc = require('@alicloud/fc2')
const moment = require('moment')
const fs = require('fs')
const fse = require('fs-extra')
const path = require('path')
const { packTo } = require('@serverless-devs/s-zip');
const OSS = require('../oss')
const { execSync } = require('child_process')

class Function {
  constructor(credentials, region) {
    this.credentials = credentials
    this.accountId = credentials.AccountID
    this.accessKeyID = credentials.AccessKeyID
    this.accessKeySecret = credentials.AccessKeySecret
    this.region = region
    this.fcClient = new fc(credentials.AccountID, {
      accessKeyID: credentials.AccessKeyID,
      accessKeySecret: credentials.AccessKeySecret,
      region: region,
      timeout: 6000000
    })
  }

  async makeCacheDir(path) {
    if (!(await fs.existsSync(path))) {
      await fs.mkdirSync(path)
    }
  }

  async getFunctionCode(code, projectName) {
    // 初始化压缩后文件地址
    const cachePath = `./.s/.cache/`;
    const zipPath = path.join(process.cwd(), `${cachePath}${projectName}.zip`);
    
    // 如果配置的 oss，直接引用
    if (typeof code !== 'string' && !code.hasOwnProperty('Src')) {
      const { Bucket, Object } = code;
      if (Bucket && Object) {
        return {
          ossBucketName: code.Bucket,
          ossObjectName: code.Object
        }
      }
      throw new Error(`CodeUri configuration does not meet expectations.`);
    }

    const packToParame = {
      outputFilePath: cachePath,
      outputFileName: `${projectName}.zip`
    };
    if (typeof code == 'string') {
      packToParame.codeUri = code;
    } else {
      packToParame.codeUri = code.Src;
      packToParame.exclude = code.Exclude;
      packToParame.include = code.Include;
    }
    
    const codeUri = packToParame.codeUri;
    if (codeUri.endsWith('.s-zip') || codeUri.endsWith('.jar') || codeUri.endsWith('.war')) {
      const srcPath = path.resolve(codeUri);
      const destPath = path.resolve(cachePath, `${projectName}.zip`);
      if (srcPath !== destPath) {
        await fse.copy(srcPath, destPath);
      }
    } else {
      const test = await packTo(packToParame);
      if (!test.count) {
        throw new Error('Zip file error');
      }
    }

    // 上传到OSS
    if (code.Bucket) {
      const oss = new OSS(this.credentials, `oss-${this.region}`, code.Bucket)
      const object = `${projectName}-${moment().format('YYYY-MM-DD')}.zip`
      await oss.uploadFile(zipPath, object)
      return {
        ossBucketName: code.Bucket,
        ossObjectName: object
      }
    }
    const data = await fs.readFileSync(zipPath);
    return {
      zipFile: Buffer.from(data).toString('base64')
    };
  }

  /**
   * Delete function
   * @param {*} serviceName
   * @param {*} functionName
   */
  async remove(serviceName, functionName) {
    try {
      console.log(`Deleting function ${serviceName}@${functionName}`)
      await this.fcClient.deleteFunction(serviceName, functionName)
      console.log(`Delete function ${serviceName}@${functionName} successfully`)
    } catch (err) {
      if (err.code != 'FunctionNotFound') {
        throw new Error(`Unable to delete function ${serviceName}@${functionName}: ${err.message}`)
      }
    }
  }

  async deploy(properties, state, projectName, serviceName) {
    const functionInput = properties.Function
    const functionProperties = {
      functionName: functionInput.Name,
      description: functionInput.Description,
      code: await this.getFunctionCode(functionInput.CodeUri, projectName),
      runtime: functionInput.Runtime ? functionInput.Runtime : DEFAULT.Runtime
    }
    const deployContainerFunction = functionProperties.runtime == "custom-container";
    if (deployContainerFunction) {
      if (!functionInput.CustomContainer) {
        throw new Error("No CustomContainer found for container runtime")
      }
      if (!functionInput.CustomContainer.Image) {
        throw new Error("No CustomContainerConfig.Image found for container runtime")
      }
      if (!functionInput.CustomContainer.CrAccount) {
        throw new Error("No CustomContainerConfig.CrAccount found for container runtime")
      }
      if (!functionInput.CustomContainer.CrAccount.User) {
        throw new Error("No CustomContainerConfig.CrAccount.User found for container runtime")
      }
      if (!functionInput.CustomContainer.CrAccount.Password) {
        throw new Error("No CustomContainerConfig.CrAccount.Password found for container runtime")
      }
      //code和customContainerConfig不能同时存在
      functionProperties.code = undefined
      functionProperties.customContainerConfig = {
        image: functionInput.CustomContainer.Image
      }
      if (functionInput.CustomContainer.Command) {
        functionProperties.customContainerConfig.command = functionInput.CustomContainer.Command
      }
      if (functionInput.CustomContainer.Args) {
        functionProperties.customContainerConfig.args = functionInput.CustomContainer.Args
      }
      
    }

    console.log(`Deploying function ${functionProperties.functionName}.`)

    functionProperties.handler = functionInput.Handler ? functionInput.Handler : DEFAULT.Handler

    if (functionInput.MemorySize) {
      functionProperties.memorySize = functionInput.MemorySize
    }
    if (functionInput.Timeout) {
      functionProperties.timeout = functionInput.Timeout
    }
    if (functionInput.Initializer && functionInput.Initializer.Handler) {
      functionProperties.initializer = functionInput.Initializer.Handler
    }
    if (functionInput.Initializer && functionInput.Initializer.Timeout) {
      functionProperties.initializationTimeout = functionInput.Initializer.Timeout
    }
    if (functionInput.Environment) {
      const EnvironmentAttr = {}
      for (let i = 0; i < functionInput.Environment.length; i++) {
        EnvironmentAttr[functionInput.Environment[i].Key] = functionInput.Environment[i].Value
      }
      functionProperties.environmentVariables = EnvironmentAttr
    }

    if (deployContainerFunction) {
      try {
        // Push image to repo for custom-container
        const customContainer = functionInput.CustomContainer;
        await this.pushImage(customContainer.CrAccount.User, customContainer.CrAccount.Password, customContainer.Image);
      } catch (e) {
        throw e;
      }
    }

    try {
      await this.fcClient.getFunction(serviceName, functionProperties.functionName)
      try {
        console.log(`Function: ${serviceName}@${functionProperties.functionName} updating ...`)
        await this.fcClient.updateFunction(
          serviceName,
          functionProperties.functionName,
          functionProperties
        )
      } catch (ex) {
        throw new Error(
          `${serviceName}:${functionProperties.functionName} update failed: ${ex.message}`
        )
      }
    } catch (e) {
      try {
        console.log(`Function: ${serviceName}@${functionProperties.functionName} creating ...`)
        await this.fcClient.createFunction(serviceName, functionProperties)
      } catch (ex) {
        throw new Error(
          `${serviceName}:${functionProperties.functionName} create failed: ${ex.message}`
        )
      }
    }

    console.log(`Deployment function ${functionProperties.functionName} successful.`)

    return functionProperties.functionName
  }

  async pushImage(userName, password, imageName) {
    try {
      const registry = imageName.split("/")[0];
      execSync(`docker login --username=${userName} ${registry} --password-stdin`, {
        input: password
      });

      execSync(`docker push ${imageName}`, {
        stdio: 'inherit'
      });

      console.log(`Push image(${imageName}) to registry successfully`);
    } catch (e) {
      console.log(e.message);
      throw e;
    }
  }
}

module.exports = Function;