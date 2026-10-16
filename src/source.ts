/** Offsets and characters use UTF-16 code units, as in JavaScript and LSP. */
export interface SourceRange {
	file: string;
	start: number;
	end: number;
}
export interface Position {
	line: number;
	character: number;
}
export interface Range {
	start: Position;
	end: Position;
}
export class SourceText {
	readonly lineStarts: number[] = [0];
	private readonly lineEnds: number[] = [];
	constructor(
		readonly file: string,
		readonly text: string,
	) {
		for (let index = 0; index < text.length; index++) {
			if (text[index] !== "\r" && text[index] !== "\n") continue;
			this.lineEnds.push(index);
			if (text[index] === "\r" && text[index + 1] === "\n") index++;
			this.lineStarts.push(index + 1);
		}
		this.lineEnds.push(text.length);
	}
	positionAt(offset: number): Position {
		offset = Math.max(0, Math.min(this.text.length, Math.trunc(offset)));
		let low = 0,
			high = this.lineStarts.length;
		while (low + 1 < high) {
			const middle = (low + high) >>> 1;
			if (this.lineStarts[middle]! > offset) high = middle;
			else low = middle;
		}
		return {
			line: low,
			character:
				Math.min(offset, this.lineEnds[low]!) - this.lineStarts[low]!,
		};
	}
	offsetAt(position: Position): number {
		const line = Math.max(0, Math.trunc(position.line));
		if (line >= this.lineStarts.length) return this.text.length;
		return Math.min(
			this.lineEnds[line]!,
			this.lineStarts[line]! +
				Math.max(0, Math.trunc(position.character)),
		);
	}
	range(range: SourceRange): Range {
		return {
			start: this.positionAt(range.start),
			end: this.positionAt(range.end),
		};
	}
}
