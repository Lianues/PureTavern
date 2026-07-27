export function normalizeChineseCustomParameterExamples(source) {
  return source
    .replace('top_k：20\\nrepetition_penalty：1.1', 'top_k: 20\\nrepetition_penalty: 1.1')
    .replace(
      'CustomHeader：自定义值\\nAnotherHeader：自定义值',
      'CustomHeader: 自定义值\\nAnotherHeader: 自定义值',
    );
}
