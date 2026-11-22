// Helpers more than one adapter needs
import fs from 'node:fs';

// ponytail: prefix heuristic for read-only shell commands; they flood memory with noise (ls, git status...).
export const READONLY_CMD =
	/^\s*(cd\s+\S+\s*&&\s*)?(rtk\s+)?(ls|ll|pwd|cat|head|tail|less|wc|grep|rg|find|fd|which|echo|tree|git (status|log|diff|show|branch))\b/;

/**
 * Text of the last JSONL transcript entry matching `pick`: the last assistant reply, or Claude Code's last compaction
 * summary. Claude nests the content under `message`; Antigravity keeps a plain string in `content`.
 */
export function lastTranscriptText(transcriptPath: string, pick: (entry: any) => boolean): string {
	try {
		const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n');
		for (let i = lines.length - 1; i >= 0; i--) {
			const entry = JSON.parse(lines[i]!);
			if (!pick(entry)) continue;
			const content: string | { type: string; text?: string }[] | undefined = entry.message?.content ?? entry.content;
			const text =
				typeof content === 'string'
					? content
					: (content || [])
							.filter((c) => c.type === 'text')
							.map((c) => c.text)
							.join('\n');
			if (text.trim()) return text;
		}
	} catch {}
	return '';
}
