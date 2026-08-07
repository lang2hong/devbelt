export function replaceEscapedOctetsWithChar(s: string) {
  return s
    .replace(/\\\\/g, '\\')
    .replace(/(?:^|[^\\])((?:\\[0-9]{3})+)/g, (substring: string, ...args: any[]) => {
      const capgroup: string = args[0].toString();
      let prevChar = '';
      if (substring.length > capgroup.length) {
        prevChar = substring[0];
      }
      const octal = capgroup.split('\\').filter((s) => s.trim() !== '');
      try {
        const chars = octalToChars(octal);
        return prevChar + chars;
      } catch (err) {
        return substring;
      }
    });
}

export function octalToChars(octal: Array<string>) {
  const hex: string = octal.map((octet) => convertFromBaseToBase(octet, 8, 16)).join('');
  const s = Buffer.from(hex, 'hex').toString('utf8');
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 65533) {
      // unknown character, this is probably binary data
      return hex;
    }
  }
  return s;
}

export function convertFromBaseToBase(str: string | number, fromBase: number, toBase: number) {
  if (typeof str === 'number') {
    str = str.toString();
  }
  const num = parseInt(str as string, fromBase);
  return num.toString(toBase);
}