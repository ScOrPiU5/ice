import fse from 'fs-extra';
import { SourceMapConsumer, SourceMapGenerator } from 'source-map';

// Starting with extra script, it's a fixed line.
const BASE_LINE = 27;
// Starting with end of '(function(){', it's a fixed column.
const BASE_COLUMN = 12;

export async function generateSourceMap({
  sourceMapFileList = [],
}) {
  const generator = new SourceMapGenerator({
    file: '',
    sourceRoot: '',
  });

  await Promise.all(sourceMapFileList.map((sourceMapFile, fileIndex) => {
    return new Promise((resolve, reject) => {
      if (!fse.existsSync(sourceMapFile)) {
        resolve(true);
      }

      const content = fse.readFileSync(sourceMapFile, 'utf-8');
      SourceMapConsumer.with(content, null, consumer => {
        // Set content by source.
        consumer.sources.forEach((source) => {
          generator.setSourceContent(source, consumer.sourceContentFor(source));
        });

        // Get each map from script,and set it to new map.
        consumer.eachMapping((mapping) => {
            if (!mapping.name) return;

            generator.addMapping({
              generated: {
                line: mapping.generatedLine + BASE_LINE + fileIndex * 2,
                column: mapping.generatedColumn + BASE_COLUMN,
              },
              original: {
                line: mapping.originalLine,
                column: mapping.originalColumn,
              },
              source: mapping.source,
              name: mapping.name,
            });
        });

        resolve(true);
      });
    });
  }));

  return generator.toString();
}