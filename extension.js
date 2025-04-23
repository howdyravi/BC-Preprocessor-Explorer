const vscode = require('vscode');
const path = require('path');

class LocationNode {
    constructor(label, filePath, line) {
        this.label = label;
        this.filePath = filePath;
        this.line = line;
        this.command = {
            command: 'al-preprocessor-explorer.goToLocation',
            title: 'Go to Location',
            arguments: [filePath, line]
        };
    }

    get collapsibleState() {
        return vscode.TreeItemCollapsibleState.None;
    }

    get tooltip() {
        return `${this.filePath}:${this.line + 1}`;
    }
}

class ObjectTypeNode {
    constructor(type, children) {
        this.label = type;
        this.children = children;
    }

    get collapsibleState() {
        return vscode.TreeItemCollapsibleState.Collapsed;
    }
}

class SymbolNode {
    constructor(symbol, groupedByType) {
        this.symbol = symbol;
        this.groupedByType = groupedByType;
    }

    get label() {
        return this.symbol;
    }

    get collapsibleState() {
        return vscode.TreeItemCollapsibleState.Collapsed;
    }
}

class ALPreprocessorTreeProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.symbols = [];
    }

    refresh(symbolMap) {
        this.symbols = [...symbolMap.entries()]
            .sort(([a], [b]) => a.localeCompare(b)) // 🔁 Sort symbols alphabetically
            .map(([symbol, locations]) => {
                const grouped = {};
                locations.forEach(loc => {
                    const objectType = loc.objectType || 'Other';
                    if (!grouped[objectType]) grouped[objectType] = [];
                    grouped[objectType].push(new LocationNode(loc.fileName, loc.uri.fsPath, loc.range.start.line));
                });
                return new SymbolNode(symbol, grouped);
            });
    
        this._onDidChangeTreeData.fire();
    }
    
    getTreeItem(element) {
        return {
            label: element.label,
            collapsibleState: element.collapsibleState,
            tooltip: element.tooltip,
            command: element.command
        };
    }

    getChildren(element) {
        if (!element) return this.symbols;
        if (element instanceof SymbolNode)
            return Object.entries(element.groupedByType).map(([type, children]) => new ObjectTypeNode(type, children));
        if (element instanceof ObjectTypeNode)
            return element.children;
        return [];
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
    const rawTokens = expression
        .replace(/\bnot\b/gi, '')
        .split(/\b(?:and|or)\b/i)
        .map(token => token.trim().replace(/[()]/g, ''));

    return rawTokens.filter(token => token.length && !/^(and|or|not)$/i.test(token));
}

function activate(context) {
    const provider = new ALPreprocessorTreeProvider();

    vscode.window.createTreeView('alPreprocessorExplorer.treeView', {
        treeDataProvider: provider
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('al-preprocessor-explorer.exploreSymbols', async () => {
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
                            const location = new vscode.Location(file, new vscode.Position(i, line.indexOf(defineMatch[0])));
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
