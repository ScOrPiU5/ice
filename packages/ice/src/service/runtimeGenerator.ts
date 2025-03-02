import path from 'path';
import fse from 'fs-extra';
import fg from 'fast-glob';
import ejs from 'ejs';
import lodash from '@ice/bundles/compiled/lodash/index.js';
import type {
  AddDeclaration,
  RemoveDeclaration,
  AddContent,
  GetDeclarations,
  ParseRenderData,
  Render,
  RenderFile,
  ModifyRenderData,
  AddRenderFile,
  AddTemplateFiles,
  RenderDataRegistration,
  RenderTemplate,
  RenderData,
  DeclarationData,
  TargetDeclarationData,
  Registration,
  TemplateOptions,
} from '../types/generator.js';
import getGlobalStyleGlobPattern from '../utils/getGlobalStyleGlobPattern.js';
import { logger } from '../utils/logger.js';

const { debounce } = lodash;

const RENDER_WAIT = 150;

interface Options {
  templateDir: string;
  rootDir: string;
  targetDir: string;
  defaultRenderData?: RenderData;
  templates?: (string | TemplateOptions)[];
}

function isDeclarationData(data: TargetDeclarationData | DeclarationData): data is DeclarationData {
  return data.declarationType === 'normal';
}

function isTargetDeclarationData(data: TargetDeclarationData | DeclarationData): data is TargetDeclarationData {
  return data.declarationType === 'target';
}

export function generateDeclaration(exportList: Array<TargetDeclarationData | DeclarationData>) {
  const targetImportDeclarations: Array<string> = [];
  const importDeclarations: Array<string> = [];
  const exportDeclarations: Array<string> = [];
  const exportNames: Array<string> = [];
  const variables: Map<string, string> = new Map();

  let moduleId = 0;
  exportList.forEach(data => {
    // Deal with target.
    if (isTargetDeclarationData(data)) {
      const { specifier, source, target, types = [] } = data;
      const isDefaultImport = !Array.isArray(specifier);
      const specifiers = isDefaultImport ? [specifier] : specifier;
      const arrTypes: Array<string> = Array.isArray(types) ? types : [types];

      moduleId++;
      const moduleName = `${target}Module${moduleId}`;
      targetImportDeclarations.push(`if (import.meta.target === '${target}') {
  ${specifiers.map(item => `${item} = ${moduleName}.${item};`).join('\n  ')}
}
      `);

      importDeclarations.push(`import ${isDefaultImport ? moduleName : `* as ${moduleName}`} from '${source}';`);

      if (arrTypes.length) {
        importDeclarations.push(`import type { ${arrTypes.join(', ')}} from '${source}';`);
      }

      specifiers.forEach((specifierStr, index) => {
        if (!variables.has(specifierStr)) {
          variables.set(specifierStr, arrTypes[index] || 'any');
        }
      });
    } else if (isDeclarationData(data)) {
      const { specifier, source, alias, type } = data;
      const isDefaultImport = !Array.isArray(specifier);
      const specifiers = isDefaultImport ? [specifier] : specifier;
      const symbol = type ? ';' : ',';

      importDeclarations.push(`import ${type ? 'type ' : ''}${isDefaultImport ? specifier : `{ ${specifiers.map(specifierStr => ((alias && alias[specifierStr]) ? `${specifierStr} as ${alias[specifierStr]}` : specifierStr)).join(', ')} }`} from '${source}';`);

      specifiers.forEach((specifierStr) => {
        if (alias && alias[specifierStr]) {
          exportDeclarations.push(`${alias[specifierStr]}: ${specifierStr}${symbol}`);
          exportNames.push(alias[specifierStr]);
        } else {
          exportDeclarations.push(`${specifierStr}${symbol}`);
          exportNames.push(specifierStr);
        }
      });
    }
  });

  return {
    targetImportStr: targetImportDeclarations.join('\n'),
    importStr: importDeclarations.join('\n'),
    targetExportStr: Array.from(variables.keys()).join(',\n  '),
    /**
     * Add two whitespace character in order to get the formatted code. For example:
     *  export {
          withAuth,
          useAuth,
        };
     */
    exportStr: exportDeclarations.join('\n  '),
    exportNames,
    variablesStr: Array.from(variables.entries()).map(item => `let ${item[0]}: ${item[1]};`).join('\n'),
  };
}

export function checkExportData(
  currentList: (DeclarationData | TargetDeclarationData)[],
  exportData: (DeclarationData | TargetDeclarationData) | (DeclarationData | TargetDeclarationData)[],
  apiName: string,
) {
  (Array.isArray(exportData) ? exportData : [exportData]).forEach((data) => {
    const exportNames = (Array.isArray(data.specifier) ? data.specifier : [data.specifier]).map((specifierStr) => {
      if (isDeclarationData(data)) {
        return data?.alias?.[specifierStr] || specifierStr;
      } else {
        return specifierStr;
      }
    });
    currentList.forEach((item) => {
      if (isTargetDeclarationData(item)) return;

      if (isDeclarationData(item)) {
        const { specifier, alias } = item;

        // check exportName and specifier
        const currentExportNames = (Array.isArray(specifier) ? specifier : [specifier]).map((specifierStr) => {
          return alias?.[specifierStr] || specifierStr;
        });

        if (currentExportNames.some((name) => exportNames.includes(name))) {
          logger.error('specifier:', specifier, 'alias:', alias);
          logger.error('duplicate with', data);
          throw new Error(`duplicate export data added by ${apiName}`);
        }
      }
    });
  });
}

export function removeDeclarations(exportList: DeclarationData[], removeSource: string | string[]) {
  const removeSourceNames = Array.isArray(removeSource) ? removeSource : [removeSource];
  return exportList.filter(({ source }) => {
    const needRemove = removeSourceNames.includes(source);
    return !needRemove;
  });
}

export default class Generator {
  private targetDir: string;

  private templateDir: string;

  private renderData: RenderData;

  private contentRegistration: Registration;

  private rerender: boolean;

  private rootDir: string;

  private renderTemplates: RenderTemplate[];

  private renderDataRegistration: RenderDataRegistration[];

  private contentTypes: string[];

  public constructor(options: Options) {
    const { rootDir, targetDir, defaultRenderData = {}, templates, templateDir } = options;
    this.rootDir = rootDir;
    this.targetDir = targetDir;
    this.templateDir = templateDir;
    this.renderData = defaultRenderData;
    this.contentRegistration = {};
    this.rerender = false;
    this.renderTemplates = [];
    this.renderDataRegistration = [];
    this.contentTypes = ['framework', 'frameworkTypes', 'routeConfigTypes', 'dataLoaderImport', 'runtimeOptions'];
    // empty .ice before render
    fse.emptyDirSync(path.join(rootDir, targetDir));
    // add initial templates
    if (templates) {
      templates.forEach(template => this.addTemplateFiles(template));
    }
  }

  public setRenderData = (renderData: RenderData) => {
    this.renderData = renderData;
  };

  private debounceRender = debounce(() => {
    this.render();
  }, RENDER_WAIT);

  public addDeclaration: AddDeclaration = (registerKey, exportData) => {
    const exportList = this.contentRegistration[registerKey] || [];
    checkExportData(exportList, exportData, registerKey);
    this.addContent(registerKey, exportData);
  };

  public removeDeclaration: RemoveDeclaration = (registerKey, removeSource) => {
    const exportList = this.contentRegistration[registerKey] || [];
    this.contentRegistration[registerKey] = removeDeclarations(exportList, removeSource);
  };

  public addContent: AddContent = (apiName, ...args) => {
    if (!this.contentTypes.includes(apiName)) {
      throw new Error(`invalid API ${apiName}`);
    }
    const [data, position] = args;
    if (position && !['before', 'after'].includes(position)) {
      throw new Error(`invalid position ${position}, use before|after`);
    }
    const registerKey = position ? `${apiName}_${position}` : apiName;
    if (!this.contentRegistration[registerKey]) {
      this.contentRegistration[registerKey] = [];
    }
    const content = Array.isArray(data) ? data : [data];
    this.contentRegistration[registerKey].push(...content);
  };

  public getExportList = (registerKey: string, target?: string) => {
    const exportList = this.contentRegistration[registerKey] || [];

    if (target) {
      return exportList.filter(exports => {
        return !(exports.target && exports.target !== target);
      });
    } else {
      return exportList;
    }
  };

  private getDeclarations: GetDeclarations = (registerKey, dataKeys) => {
    const exportList = this.contentRegistration[registerKey] || [];
    const {
      importStr,
      exportStr,
      exportNames,
      targetExportStr,
      targetImportStr,
      variablesStr,
    } = generateDeclaration(exportList);
    const [importStrKey, exportStrKey, targetImportStrKey, targetExportStrKey] = dataKeys;
    return {
      [importStrKey]: importStr,
      [exportStrKey]: exportStr,
      exportNames,
      variablesStr,
      [targetImportStrKey]: targetImportStr,
      [targetExportStrKey]: targetExportStr,
    };
  };

  public parseRenderData: ParseRenderData = () => {
    const staticConfig = fg.sync(['src/manifest.json'], { cwd: this.rootDir });
    const globalStyles = fg.sync([getGlobalStyleGlobPattern()], { cwd: this.rootDir });
    let exportsData = {};
    this.contentTypes.forEach(item => {
      const data = this.getDeclarations(item, ['imports', 'exports', 'targetImport', 'targetExports']);
      exportsData = Object.assign({}, exportsData, {
        [`${item}`]: data,
      });
    });

    return {
      ...this.renderData,
      ...exportsData,
      staticConfig: staticConfig.length && staticConfig[0],
      globalStyle: globalStyles.length && `@/${path.basename(globalStyles[0])}`,
    };
  };

  public render: Render = () => {
    this.rerender = true;
    this.renderData = this.renderDataRegistration.reduce((previousValue, currentValue) => {
      if (typeof currentValue === 'function') {
        return currentValue(previousValue);
      }
      return previousValue;
    }, this.parseRenderData());

    this.renderTemplates.forEach((args) => {
      this.renderFile(...args);
    });
  };

  public addRenderFile: AddRenderFile = (templatePath, targetPath, extraData = {}) => {
    // check target path if it is already been registered
    const renderIndex = this.renderTemplates.findIndex(([, templateTarget]) => templateTarget === targetPath);
    if (renderIndex > -1) {
      const targetTemplate = this.renderTemplates[renderIndex];
      if (targetTemplate[0] !== templatePath) {
        logger.error('[template]', `path ${targetPath} already been rendered as file ${targetTemplate[0]}`);
      }
      // replace template with latest content
      this.renderTemplates[renderIndex] = [templatePath, targetPath, extraData];
    } else {
      this.renderTemplates.push([templatePath, targetPath, extraData]);
    }
    if (this.rerender) {
      this.debounceRender();
    }
  };

  public addTemplateFiles: AddTemplateFiles = (templateOptions, extraData = {}) => {
    const { template, targetDir } = typeof templateOptions === 'string' ? { template: templateOptions, targetDir: '' } : templateOptions;
    const templates = path.extname(template)
      ? [template]
      : fg.sync(['**/*'], { cwd: template });
    templates.forEach((templateFile) => {
      const templatePath = path.isAbsolute(templateFile) ? templateFile : path.join(template, templateFile);
      const filePath = path.isAbsolute(templateFile) ? path.basename(templateFile) : templateFile;
      const targetPath = path.join(targetDir, filePath);
      this.addRenderFile(templatePath, targetPath, extraData);
    });
    if (this.rerender) {
      this.debounceRender();
    }
  };

  public modifyRenderData: ModifyRenderData = (registration) => {
    this.renderDataRegistration.push(registration);
    if (this.rerender) {
      this.debounceRender();
    }
  };

  public renderFile: RenderFile = (templatePath, targetPath, extraData = {}) => {
    const renderExt = '.ejs';
    const realTargetPath = path.isAbsolute(targetPath)
      ? targetPath : path.join(this.rootDir, this.targetDir, targetPath);
    // example: templatePath = 'routes.ts.ejs'
    const realTemplatePath = path.isAbsolute(templatePath)
      ? templatePath : path.join(this.templateDir, templatePath);
    const { ext } = path.parse(templatePath);
    if (ext === renderExt) {
      const templateContent = fse.readFileSync(realTemplatePath, 'utf-8');
      let renderData = { ...this.renderData };
      if (typeof extraData === 'function') {
        renderData = extraData(this.renderData);
      } else {
        renderData = {
          ...renderData,
          ...extraData,
        };
      }
      const content = ejs.render(templateContent, renderData);
      fse.writeFileSync(realTargetPath.replace(renderExt, ''), content, 'utf-8');
    } else {
      fse.ensureDirSync(path.dirname(realTargetPath));
      fse.copyFileSync(realTemplatePath, realTargetPath);
    }
  };
}
