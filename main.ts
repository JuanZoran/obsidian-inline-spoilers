import { syntaxTree } from '@codemirror/language';
import { SyntaxNode } from '@lezer/common';
import { Extension, RangeSetBuilder } from '@codemirror/state';
import {
	Decoration,
	DecorationSet,
	EditorView,
	PluginSpec,
	PluginValue,
	ViewPlugin,
	ViewUpdate,
} from '@codemirror/view';
import { App, Editor, Plugin, PluginSettingTab, Setting, Workspace } from 'obsidian';

const SPOILER_REGEX = /\|\|([\s\S]+?)\|\|/g;

/*
 * Reading mode
 */
type SpoilerSlice = {
	node: Text;
	isDelimiter: boolean;
};

const isTextNodeInIgnoredWrapper = (textNode: Text) => {
	const parent = textNode.parentElement;
	if (!parent) return false;

	if (parent.closest(".inline_spoilers-spoiler")) return true;
	if (parent.closest("code, pre, samp, kbd")) return true;
	if (parent.closest(".cm-inline-code, .math, .latex")) return true;

	return false;
};

const splitTextNodeByDelimiter = (textNode: Text, slices: SpoilerSlice[]) => {
	let node: Text | null = textNode;

	while (node) {
		const delimiterIndex = node.data.indexOf("||");

		if (delimiterIndex === -1) {
			slices.push({ node, isDelimiter: false });
			node = null;
			continue;
		}

		if (delimiterIndex > 0) {
			const after = node.splitText(delimiterIndex);
			slices.push({ node, isDelimiter: false });
			node = after;
			continue;
		}

		// delimiter is at the beginning of the text node
		if (node.data.length > 2) {
			const after = node.splitText(2);
			slices.push({ node, isDelimiter: true });
			node = after;
		} else {
			slices.push({ node, isDelimiter: true });
			node = null;
		}
	}
};

const wrapSpoilers = (element: HTMLElement) => {
	// Collect text nodes first to avoid mutating the tree mid-iteration
	const textNodes: Text[] = [];
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	let current: Node | null;

	while ((current = walker.nextNode())) {
		const textNode = current as Text;

		if (isTextNodeInIgnoredWrapper(textNode)) {
			continue;  // skip already processed text or disallowed wrappers
		}

		textNodes.push(textNode);
	}

	const slices: SpoilerSlice[] = [];
	for (const textNode of textNodes) {
		splitTextNodeByDelimiter(textNode, slices);
	}

	let openDelimiter: Text | null = null;

	for (const slice of slices) {
		if (!slice.isDelimiter) {
			continue;
		}

		if (!openDelimiter) {
			openDelimiter = slice.node;
			continue;
		}

		// We found a closing delimiter; wrap everything in between
		const startDelimiter = openDelimiter;
		const endDelimiter = slice.node;

		const range = document.createRange();
		range.setStartAfter(startDelimiter);
		range.setEndBefore(endDelimiter);

		if (!range.collapsed) {
			const contents = range.extractContents();
			const spoilerSpan = createSpan({ cls: "inline_spoilers-spoiler" });
			spoilerSpan.appendChild(contents);
			endDelimiter.parentNode?.insertBefore(spoilerSpan, endDelimiter);
		}

		startDelimiter.parentNode?.removeChild(startDelimiter);
		endDelimiter.parentNode?.removeChild(endDelimiter);
		openDelimiter = null;
	}
};

const updateReadingMode = (element: HTMLElement, plugin: InlineSpoilerPlugin) => {
	const allowedElems = element.findAll("p, li, h1, h2, h3, h4, h5, h6, blockquote, em, strong, b, i, a, th, td");

	for (const elem of allowedElems) {
		wrapSpoilers(elem as HTMLElement);
	}

	const spoilers = element.findAll(".inline_spoilers-spoiler");

	for (const spoiler of spoilers) {
		plugin.registerDomEvent(spoiler, 'click', () => {
			spoiler.classList.toggle("inline_spoilers-revealed");
		});
	}
}

const unloadReadingMode = (workspace: Workspace) => {
	// remove all spoilers from reader mode
	const spoilers = Array.from(workspace.containerEl.querySelectorAll(".inline_spoilers-spoiler")) as HTMLElement[];
	for (const spoiler of spoilers) {
		const parent = spoiler.parentNode;
		const fragment = document.createDocumentFragment();
		fragment.appendChild(document.createTextNode("||"));
		while (spoiler.firstChild) {
			fragment.appendChild(spoiler.firstChild);
		}
		fragment.appendChild(document.createTextNode("||"));
		if (parent) {
			parent.replaceChild(fragment, spoiler);
		}
	}
}



/*
 * Editor mode
 */
class SpoilerEditorPlugin implements PluginValue {
	decorations: DecorationSet;
	view: EditorView;
	mouseOverHandler: (event: MouseEvent) => void;
	mouseOutHandler: (event: MouseEvent) => void;

	constructor(view: EditorView) {
		this.view = view;
		this.decorations = this.buildDecorations(view);
		this.mouseOverHandler = this.handleMouseOver.bind(this);
		this.mouseOutHandler = this.handleMouseOut.bind(this);
		this.view.dom.addEventListener("mouseover", this.mouseOverHandler);
		this.view.dom.addEventListener("mouseout", this.mouseOutHandler);
	}

	update(update: ViewUpdate) {
		if (update.docChanged || update.viewportChanged) {
			this.decorations = this.buildDecorations(update.view);
		}
	}

	destroy() {
		this.view.dom.removeEventListener("mouseover", this.mouseOverHandler);
		this.view.dom.removeEventListener("mouseout", this.mouseOutHandler);
	}

	handleMouseOver(event: MouseEvent) {
		const target = event.target as HTMLElement | null;
		const el = target?.closest<HTMLElement>("[data-inline-spoiler-group]");
		const group = el?.dataset.inlineSpoilerGroup;
		if (!group) return;

		this.toggleGroup(group, true);
	}

	handleMouseOut(event: MouseEvent) {
		const target = event.target as HTMLElement | null;
		const el = target?.closest<HTMLElement>("[data-inline-spoiler-group]");
		const group = el?.dataset.inlineSpoilerGroup;
		if (!group) return;

		const related = event.relatedTarget as HTMLElement | null;
		if (related?.closest(`[data-inline-spoiler-group="${group}"]`)) {
			return;  // still inside the same spoiler group
		}

		this.toggleGroup(group, false);
	}

	toggleGroup(group: string, reveal: boolean) {
		const nodes = this.view.dom.querySelectorAll<HTMLElement>(`[data-inline-spoiler-group="${group}"]`);
		nodes.forEach((node) => {
			node.classList.toggle("inline_spoilers-editor-spoiler-hover", reveal);
		});
	}

	buildDecorations(view: EditorView): DecorationSet {
		const builder = new RangeSetBuilder<Decoration>();
		const ranges: { from: number, to: number, isDelimiter: boolean, group: string }[] = [];
		const tree = syntaxTree(view.state);
		const isDelimiterInIgnoredSyntax = (from: number, to: number) => {
			const check = (pos: number) => {
				let node: SyntaxNode | null = tree.resolveInner(pos);
				while (node) {
					const name = node.name;
					if (name.includes("Code") || name.includes("Math") || name.includes("Comment") || name.includes("HTML")) {
						return true;
					}
					node = node.parent;
				}
				return false;
			};

			const endPos = Math.max(to - 1, from);
			return check(from) || check(endPos);
		};
		let groupId = 0;

		for (const { from, to } of view.visibleRanges) {
			const text = view.state.sliceDoc(from, to);
			SPOILER_REGEX.lastIndex = 0;  // reset per range to avoid bleed-over
			let match: RegExpExecArray | null;

			while ((match = SPOILER_REGEX.exec(text)) !== null) {
				const start = from + match.index;
				const end = start + match[0].length;
				const group = `spoiler-${groupId++}`;

				const slice = view.state.sliceDoc(start, end);

				if (!slice.startsWith("||") && !slice.endsWith("||")) {
					continue;  // sanity check
				}

				if (isDelimiterInIgnoredSyntax(start, start + 2) || isDelimiterInIgnoredSyntax(end - 2, end)) {
					continue;  // skip spoilers inside code/math/html/comment nodes
				}

				ranges.push({ from: start, to: start + 2, isDelimiter: true, group });
				ranges.push({ from: start + 2, to: end - 2, isDelimiter: false, group });
				ranges.push({ from: end - 2, to: end, isDelimiter: true, group });
			}
		}

		// Sort ranges by `from` position to prevent Codemirror error
		ranges.sort((a, b) => a.from - b.from);

		// Add sorted ranges to the builder
		for (const range of ranges) {
			const decoration = Decoration.mark({
				class: range.isDelimiter ? "inline_spoilers-editor-spoiler-delimiter" : "inline_spoilers-editor-spoiler",
				tagName: "span",
				attributes: { "data-inline-spoiler-group": range.group },
			});
			builder.add(range.from, range.to, decoration);
		}

		return builder.finish();
	}
}

const pluginSpec: PluginSpec<SpoilerEditorPlugin> = {
	decorations: (value: SpoilerEditorPlugin) => value.decorations,
};

const spoilerEditorPlugin = ViewPlugin.fromClass(
	SpoilerEditorPlugin,
	pluginSpec
);

const editorPlugins: Extension[] = [];

const loadEditorPlugin = (workspace: Workspace) => {
	if (!editorPlugins.includes(spoilerEditorPlugin)) {
		editorPlugins.push(spoilerEditorPlugin);
	}

	workspace.updateOptions();
}

const unloadEditorPlugin = (workspace: Workspace) => {
	const index = editorPlugins.indexOf(spoilerEditorPlugin);
	if (index !== -1) {
		editorPlugins.splice(index, 1);
	}

	workspace.updateOptions();
}

/*
 * Settings
 */
interface InlineSpoilerPluginSettings {
	showAllSpoilers: boolean;
	enableEditorMode: boolean;
}

const DEFAULT_SETTINGS: InlineSpoilerPluginSettings = {
	showAllSpoilers: false,
	enableEditorMode: false,
}

class InlineSpoilerPluginSettingsTab extends PluginSettingTab {
	plugin: InlineSpoilerPlugin;

	constructor(app: App, plugin: InlineSpoilerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Reveal all spoilers')
			.setDesc('Always show all inline spoilers, regardless of whether they are clicked or not.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showAllSpoilers)
				.onChange(async (value) => {
					this.plugin.settings.showAllSpoilers = value;
					this.app.workspace.containerEl.toggleClass("inline_spoilers-revealed", value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Hide spoilers in editor view (experimental)')
			.setDesc('Hide spoilers in the editor until your cursor is on the same line as the spoiler.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableEditorMode)
				.onChange(async (value) => {
					this.plugin.settings.enableEditorMode = value;

					if (value) {
						loadEditorPlugin(this.app.workspace);
					} else {
						unloadEditorPlugin(this.app.workspace);
					}

					await this.plugin.saveSettings();
				}));
	}
}



/*
 * Obsidian plugin interface
 */
export default class InlineSpoilerPlugin extends Plugin {
	settings!: InlineSpoilerPluginSettings;

	async onload() {
		await this.loadSettings();

		const readingView = this.app.workspace.containerEl.querySelector(".markdown-reading-view");
		if (readingView) {
			updateReadingMode(readingView as HTMLElement, this);
		}

		this.registerMarkdownPostProcessor((element) => {
			updateReadingMode(element, this);
		});

		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'create-spoiler',
			name: 'Create spoiler',
			editorCallback: (editor: Editor) => {
				const selection = editor.getSelection();
				editor.replaceSelection(`||${selection}||`);
			}
		});

		this.registerEditorExtension(editorPlugins);

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new InlineSpoilerPluginSettingsTab(this.app, this));
	}

	onunload() {
		this.app.workspace.containerEl.classList.remove("inline_spoilers-revealed");
		unloadReadingMode(this.app.workspace);
		unloadEditorPlugin(this.app.workspace);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.app.workspace.containerEl.toggleClass("inline_spoilers-revealed", this.settings.showAllSpoilers);
		if (this.settings.enableEditorMode) {
			editorPlugins.push(spoilerEditorPlugin);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
