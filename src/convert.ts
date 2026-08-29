// 依赖 Obsidian 渲染进程自带的 DOMParser，无需外部依赖。
// 覆盖常见网页元素；未识别的标签按透明容器处理。

const BLOCK_TAGS = new Set([
	"p",
	"div",
	"section",
	"article",
	"header",
	"footer",
	"main",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"ul",
	"ol",
	"li",
	"blockquote",
	"pre",
	"table",
	"hr",
	"figure",
	"figcaption",
	"address",
	"dl",
	"dt",
	"dd",
]);

const TRANSPARENT_TAGS = new Set(["span", "font", "article", "main", "body", "html", "center", "abbr", "time", "small", "mark", "u", "sup", "sub"]);

export function htmlToMarkdown(html: string): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	doc
		.querySelectorAll(
			"script,style,noscript,iframe,svg,canvas,form,button,input,select,textarea,link,meta,nav,aside,video,audio",
		)
		.forEach((el) => el.remove());
	const out = convertChildren(doc.body).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	return out ? out + "\n" : "";
}

function isBlock(node: Node): boolean {
	return node.nodeType === 1 && BLOCK_TAGS.has((node as Element).tagName.toLowerCase());
}

function convertChildren(node: Node): string {
	let out = "";
	node.childNodes.forEach((child) => {
		out += convertNode(child);
	});
	return out;
}

function inlineText(el: Element): string {
	return convertChildren(el).replace(/\s+/g, " ").trim();
}

function convertNode(node: Node): string {
	if (node.nodeType === 3) {
		return (node.textContent ?? "").replace(/\s+/g, " ");
	}
	if (node.nodeType !== 1) return "";
	const el = node as Element;
	const tag = el.tagName.toLowerCase();

	switch (tag) {
		case "h1":
		case "h2":
		case "h3":
		case "h4":
		case "h5":
		case "h6": {
			const level = Number(tag[1]);
			return `\n\n${"#".repeat(level)} ${inlineText(el)}\n\n`;
		}
		case "p":
			return `\n\n${convertChildren(el).trim()}\n\n`;
		case "br":
			return "\n";
		case "hr":
			return "\n\n---\n\n";
		case "strong":
		case "b": {
			const t = inlineText(el);
			return t ? ` **${t}** ` : "";
		}
		case "em":
		case "i": {
			const t = inlineText(el);
			return t ? ` *${t}* ` : "";
		}
		case "del":
		case "s":
		case "strike": {
			const t = inlineText(el);
			return t ? ` ~~${t}~~ ` : "";
		}
		case "code": {
			if (el.parentElement && el.parentElement.tagName.toLowerCase() === "pre") {
				return el.textContent ?? "";
			}
			const t = el.textContent ?? "";
			return t.includes("`") ? `\`\`\` ${t} \`\`\`` : `\`${t}\``;
		}
		case "pre": {
			const codeEl = el.querySelector("code");
			const lang = codeEl
				? (Array.from(codeEl.classList)
						.find((c) => c.startsWith("language-"))
						?.slice("language-".length) ?? "")
				: "";
			return `\n\n\`\`\`${lang}\n${(el.textContent ?? "").replace(/\n+$/, "")}\n\`\`\`\n\n`;
		}
		case "a": {
			const href = el.getAttribute("href") ?? "";
			const t = inlineText(el);
			if (!href) return t;
			if (!t || t === href) return `<${href}>`;
			return `[${t}](${href})`;
		}
		case "img": {
			const src = el.getAttribute("src") ?? el.getAttribute("data-src") ?? "";
			if (!src) return "";
			const alt = el.getAttribute("alt") ?? "";
			return `![${alt}](${src})`;
		}
		case "figure": {
			const img = el.querySelector("img");
			const cap = el.querySelector("figcaption");
			let out = "\n\n";
			if (img) out += `![${img.getAttribute("alt") ?? ""}](${img.getAttribute("src") ?? ""})`;
			if (cap) out += `\n\n*${inlineText(cap)}*`;
			return out + "\n\n";
		}
		case "figcaption":
			return `\n\n*${inlineText(el)}*\n\n`;
		case "ul":
		case "ol":
			return "\n\n" + convertList(el, tag === "ol", 0) + "\n\n";
		case "blockquote": {
			const inner = convertChildren(el).trim();
			const quoted = inner
				.split("\n")
				.map((line) => (line.trim() ? `> ${line}` : ">"))
				.join("\n");
			return `\n\n${quoted}\n\n`;
		}
		case "table":
			return "\n\n" + convertTable(el) + "\n\n";
		case "dl": {
			let out = "\n\n";
			el.querySelectorAll(":scope > dt").forEach((dt, i) => {
				const dd = el.querySelectorAll(":scope > dd")[i];
				out += `**${inlineText(dt)}**\n`;
				if (dd) out += `: ${inlineText(dd)}\n`;
			});
			return out + "\n\n";
		}
		default: {
			if (TRANSPARENT_TAGS.has(tag)) return convertChildren(el);
			// div 等容器：含块级子元素则按容器递归，否则当段落
			const hasBlockChild = Array.from(el.children).some((c) => BLOCK_TAGS.has(c.tagName.toLowerCase()));
			if (hasBlockChild) return convertChildren(el);
			return `\n\n${convertChildren(el).trim()}\n\n`;
		}
	}
}

function convertList(list: Element, ordered: boolean, depth: number): string {
	const lines: string[] = [];
	let index = 1;
	Array.from(list.children).forEach((child) => {
		if (child.tagName.toLowerCase() !== "li") return;
		const marker = ordered ? `${index++}. ` : "- ";
		// li 内部：先取非列表内容，再取嵌套列表
		const nested = Array.from(child.children).filter((c) => ["ul", "ol"].includes(c.tagName.toLowerCase()));
		const clone = child.cloneNode(true) as Element;
		clone.querySelectorAll("ul,ol").forEach((n) => n.remove());
		const head = convertNodeInner(clone).trim();
		lines.push("  ".repeat(depth) + marker + head);
		nested.forEach((nList) => {
			lines.push(convertList(nList, nList.tagName.toLowerCase() === "ol", depth + 1).replace(/\n$/, ""));
		});
	});
	return lines.join("\n") + "\n";
}

// 与 convertNode 相同，但列表项内容按段落拼装（不额外加换行）
function convertNodeInner(el: Element): string {
	let out = "";
	el.childNodes.forEach((child) => {
		if (child.nodeType === 3) {
			out += (child.textContent ?? "").replace(/\s+/g, " ");
		} else if (child.nodeType === 1) {
			const tag = (child as Element).tagName.toLowerCase();
			if (["p", "div", "section"].includes(tag)) {
				out += convertChildren(child).trim() + " ";
			} else {
				out += convertNode(child);
			}
		}
	});
	return out.replace(/\s+/g, " ").trim();
}

function convertTable(table: Element): string {
	const rows: string[][] = [];
	table.querySelectorAll("tr").forEach((tr) => {
		const cells: string[] = [];
		tr.querySelectorAll("th,td").forEach((cell) => cells.push(inlineText(cell).replace(/\|/g, "\\|")));
		if (cells.length) rows.push(cells);
	});
	if (!rows.length) return "";
	const width = Math.max(...rows.map((r) => r.length));
	const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
	const [head, ...body] = rows;
	const headCells = pad(head ?? Array(width).fill(""));
	const lines = [`| ${headCells.join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`];
	body.forEach((r) => lines.push(`| ${pad(r).join(" | ")} |`));
	return lines.join("\n");
}

// ---- frontmatter ----

function yamlValue(v: string | number): string {
	const s = String(v);
	if (s === "") return '""';
	if (/^[\w.\-/:]+$/.test(s) && !/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s)) return s;
	return JSON.stringify(s);
}

export function buildFrontmatter(
	fields: Record<string, string | number | string[] | undefined | null>,
): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined || value === null || value === "") continue;
		if (Array.isArray(value)) {
			if (!value.length) continue;
			lines.push(`${key}:`);
			value.forEach((v) => lines.push(`  - ${yamlValue(v)}`));
		} else {
			lines.push(`${key}: ${yamlValue(value)}`);
		}
	}
	if (!lines.length) return "";
	return `---\n${lines.join("\n")}\n---\n\n`;
}

/** 提取 frontmatter 中某字段（上行回环检测用） */
export function frontmatterHasKey(content: string, keys: string[]): boolean {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!m) return false;
	return keys.some((k) => new RegExp(`^\\s*${k}\\s*:`, "m").test(m[1]));
}
