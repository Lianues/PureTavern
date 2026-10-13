// Versioned, strict patches of generated files only; legacy/upstream remains byte-for-byte intact.
const download = `export function download(content, fileName, contentType) {
    const a = document.createElement('a');
    const file = new Blob([content], { type: contentType });
    a.href = URL.createObjectURL(file);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
}`;

export function patchLegacyDownload(source) {
  return replaceOnce(
    source,
    download,
    `export function download(content, fileName, contentType) {
    const file = new Blob([content], { type: contentType });
    return globalThis.__PURE_TAVERN_DOWNLOAD_FILE__(file, fileName);
}`,
  );
}

export function patchLegacyChatExport(source) {
  return replaceOnce(
    source,
    `                toastr.success(data.message);
                download(data.result, body.exportfilename, mimeType);`,
    `                await download(data.result, body.exportfilename, mimeType);`,
  );
}

function replaceOnce(source, anchor, replacement) {
  const count = source.split(anchor).length - 1;
  if (count !== 1)
    throw new Error(`Legacy file-save patch expected exactly one anchor, found ${count}.`);
  return source.replace(anchor, replacement);
}
