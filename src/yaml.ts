import * as yaml from 'yaml';

export type CSTScalarToken = yaml.CST.FlowScalar | yaml.CST.BlockScalar;

export class ScalarTokenWriter {
  constructor(
    private scalarToken: CSTScalarToken,
    private schema: yaml.Schema,
  ) {}

  write(value: string): void {
    // We're writing to the CST so that we can preserve formatting. But CSTs don't
    // know about the difference between numbers and strings, so we can't use the
    // yaml module's built in ability to say "hey, I'm writing a string, please
    // quote it if necessary". We borrow the logic from
    // https://github.com/eemeli/yaml/blob/b7696fc0018/src/stringify/stringifyString.ts#L326-L329
    // to check if it needs quotes. We then force it to single-quote unless it's
    // already quoted (in which case we leave the quote style alone). (Passing
    // `type: undefined` means to leave the style alone.)
    const test = (tag: yaml.CollectionTag | yaml.ScalarTag): boolean =>
      !!(
        tag.default &&
        tag.tag !== 'tag:yaml.org,2002:str' &&
        tag.test?.test(value)
      );
    const needsQuote =
      this.schema.tags.some(test) || !!this.schema.compat?.some(test);
    const alreadyQuoted =
      this.scalarToken.type === 'single-quoted-scalar' ||
      this.scalarToken.type === 'double-quoted-scalar' ||
      this.scalarToken.type === 'block-scalar';
    yaml.CST.setScalarValue(this.scalarToken, value, {
      type: needsQuote && !alreadyQuoted ? 'QUOTE_SINGLE' : undefined,
    });
  }
}
