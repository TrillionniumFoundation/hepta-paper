export function stripLatexComment(line) {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '%') continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0) return line.slice(0, index);
  }
  return line;
}
