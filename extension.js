const vscode = require('vscode');
const path = require('path');

class LineNumberNode {
    constructor(line, filePath) {
        this.label = `Line ${line + 1}`;
        this.filePath = filePath;
        this.line = line;
        this.collapsibleState = vscode.TreeItemCollapsibleState.None;
        this.command = {
            command: 'al-preprocessor-explorer.goToLocation',
            title: 'Go to Location',
            arguments: [filePath, line]
        };
        this.iconPath = new vscode.ThemeIcon('circle-small');
    }

    get tooltip() {
        return `${this.filePath}:${this.line + 1}`;
    }
}

class ObjectNode {
    constructor(objectType, fileName, filePath, lineNumbers) {
        this.label = `${fileName}`;
        this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        this.children = lineNumbers
            .sort((a, b) => a - b)
            .map(line => new LineNumberNode(line, filePath));
        this.iconPath = new vscode.ThemeIcon(getThemeIconForObjectType(objectType));
    }
}

class SymbolNode {
    constructor(symbol) {
        this.label = `#${symbol}`;
        this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        this.children = [];
    }
}

class FolderNode {
    constructor(folderName) {
        this.label = folderName;
        this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        this.children = [];

        const iconName = 'folder.svg'; // or .png
        this.iconPath = {
            light: path.join(__filename, '..', 'media', iconName),
            dark: path.join(__filename, '..', 'media', iconName)
        };
    }
}


class ALPreprocessorTreeProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.folders = [];
        this.cachedSymbolMap = new Map(); // for refresh use
    }

    refresh(symbolMap) {
        this.cachedSymbolMap = symbolMap;
        const folderMap = new Map();

        for (const [symbol, occurrences] of symbolMap.entries()) {
            for (const occ of occurrences) {
                const folder = vscode.workspace.getWorkspaceFolder(occ.uri)?.name || 'Other';
                if (!folderMap.has(folder)) folderMap.set(folder, new Map());
                const folderSymbols = folderMap.get(folder);

                if (!folderSymbols.has(symbol)) folderSymbols.set(symbol, new Map());
                const objectMap = folderSymbols.get(symbol);

                const objectKey = `${occ.objectType}|${occ.fileName}|${occ.uri.fsPath}`;
                if (!objectMap.has(objectKey)) objectMap.set(objectKey, []);
                objectMap.get(objectKey).push(occ.range.start.line);
            }
        }

        this.folders = [];

        for (const [folderName, symbols] of folderMap.entries()) {
            const folderNode = new FolderNode(folderName);

            const sortedSymbols = Array.from(symbols.entries()).sort(([a], [b]) => a.localeCompare(b));
            for (const [symbol, objects] of sortedSymbols) {
                const symbolNode = new SymbolNode(symbol);

                const sortedObjects = Array.from(objects.entries()).sort(([a], [b]) => {
                    const [typeA] = a.split('|');
                    const [typeB] = b.split('|');
                    return typeA.localeCompare(typeB);
                });

                for (const [objectKey, lines] of sortedObjects) {
                    const [objectType, fileName, filePath] = objectKey.split('|');
                    const objectNode = new ObjectNode(objectType, fileName, filePath, lines);
                    symbolNode.children.push(objectNode);
                }

                folderNode.children.push(symbolNode);
            }

            this.folders.push(folderNode);
        }

        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return {
            label: element.label,
            collapsibleState: element.collapsibleState,
            tooltip: element.tooltip,
            iconPath: element.iconPath,
            command: element.command
        };
    }

    getChildren(element) {
        if (!element) return this.folders;
        return element.children || [];
    }
}

function getThemeIconForObjectType(type) {
    switch (type.toLowerCase()) {
        case 'table': return 'database';
        case 'page': return 'symbol-structure';
        case 'codeunit': return 'symbol-method';
        case 'report': return 'book';
        case 'query': return 'search';
        case 'enum': return 'symbol-enum';
        case 'interface': return 'symbol-interface';
        default: return 'symbol-misc';
    }
}

function getALObjectInfo(text, filePath) {
    const match = text.match(/(table|page|codeunit|report|query|enum|interface)\s+(\d+)?\s*(".*?"|\w+)/i);
    if (match) {
        return {
            objectType: capitalize(match[1]),
            fileName: path.basename(filePath)
        };
    }
    return {
        objectType: 'Other',
        fileName: path.basename(filePath)
    };
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function isLineCommented(line) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) return true;
    const commentIndex = trimmed.indexOf('//');
    const directiveIndex = trimmed.search(/#(if|elseif|define|ifdef|ifndef)/i);
    return commentIndex !== -1 && commentIndex < directiveIndex;
}

function extractSymbolsFromDirective(line) {
    const match = line.match(/#(if|elseif|ifdef|ifndef)\s+(.+)/i);
    if (!match) return [];
    const expression = match[2];
    return expression
        .replace(/\bnot\b/gi, '')
        .split(/\b(?:and|or)\b/i)
        .map(token => token.trim().replace(/[()]/g, ''))
        .filter(token => token.length && !/^(and|or|not)$/i.test(token));
}

function activate(context) {
    const provider = new ALPreprocessorTreeProvider();

    vscode.window.createTreeView('alPreprocessorExplorer.treeView', {
        treeDataProvider: provider
    });

    const exploreSymbols = async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Exploring AL Preprocessor Symbols...",
            cancellable: false
        }, async () => {
            const files = await vscode.workspace.findFiles('**/*.al', '**/node_modules/**');
            const symbolMap = new Map();

            for (const file of files) {
                const document = await vscode.workspace.openTextDocument(file);
                const text = document.getText();
                const lines = text.split('\n');
                const { objectType, fileName } = getALObjectInfo(text, file.fsPath);

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (isLineCommented(line)) continue;

                    const defineMatch = line.match(/^\s*#define\s+(\w+)/i);
                    if (defineMatch) {
                        const symbol = defineMatch[1];
                        const location = new vscode.Location(file, new vscode.Position(i, 0));
                        location.fileName = fileName;
                        location.objectType = objectType;
                        if (!symbolMap.has(symbol)) symbolMap.set(symbol, []);
                        symbolMap.get(symbol).push(location);
                    }

                    const usedSymbols = extractSymbolsFromDirective(line);
                    for (const symbol of usedSymbols) {
                        const index = line.indexOf(symbol);
                        const location = new vscode.Location(file, new vscode.Position(i, index));
                        location.fileName = fileName;
                        location.objectType = objectType;
                        if (!symbolMap.has(symbol)) symbolMap.set(symbol, []);
                        symbolMap.get(symbol).push(location);
                    }
                }
            }

            provider.refresh(symbolMap);
        });
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('al-preprocessor-explorer.exploreSymbols', exploreSymbols),

        vscode.commands.registerCommand('al-preprocessor-explorer.refresh', () => {
            exploreSymbols(); // re-trigger symbol gathering and refresh
        }),

        vscode.commands.registerCommand('al-preprocessor-explorer.goToLocation', (filePath, line) => {
            vscode.workspace.openTextDocument(filePath).then(doc => {
                const pos = new vscode.Position(line, 0);
                vscode.window.showTextDocument(doc, { selection: new vscode.Selection(pos, pos) });
            });
        }),

        vscode.commands.registerCommand('al-preprocessor-explorer.collapseAll', () => {
            vscode.commands.executeCommand('workbench.actions.treeView.alPreprocessorExplorer.treeView.collapseAll');
        })
    );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
