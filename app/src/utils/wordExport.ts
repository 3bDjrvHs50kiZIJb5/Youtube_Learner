import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  PageOrientation,
  Packer,
  Paragraph,
  TextRun,
  convertInchesToTwip,
} from 'docx';
import type { WordEntry } from '../types';

/**
 * 把毫秒格式化成 mm:ss,方便在导出文档里标注句子的时间戳。
 */
function formatTime(ms?: number): string {
  if (ms == null || !isFinite(ms) || ms < 0) return '';
  const sec = Math.floor(ms / 1000);
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 从完整路径里抽出文件名,不带扩展名;用于显示"来自哪个视频"。 */
function videoFileName(p?: string): string {
  if (!p) return '';
  const name = p.split(/[\\/]/).pop() || '';
  return name.replace(/\.[^.]+$/, '');
}

/**
 * 生成单个生词条目的段落列表。
 * 排版思路:
 *  - 第 1 行: 序号 + 单词(加粗加大) + 音标(灰色斜体) + 词性(淡色)
 *  - 第 2 行: 释义
 *  - 第 3 行: 语境释义
 *  - 第 4 行: 原句(斜体,引号包裹)
 *  - 第 5 行(可选): 出处 = 视频名 + 时间戳
 * 每个条目之间留一行空白,方便打印后逐条对照。
 */
function buildWordParagraphs(entry: WordEntry, index: number): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  const headerRuns: TextRun[] = [
    new TextRun({ text: `${index + 1}. `, bold: true, size: 28, color: '5B8CFF' }),
    new TextRun({ text: entry.word, bold: true, size: 32 }),
  ];
  if (entry.phonetic) {
    headerRuns.push(
      new TextRun({ text: `  ${entry.phonetic}`, italics: true, size: 22, color: '666666' })
    );
  }
  if (entry.pos) {
    headerRuns.push(new TextRun({ text: `  ${entry.pos}`, size: 22, color: '888888' }));
  }
  paragraphs.push(
    new Paragraph({
      children: headerRuns,
      spacing: { before: 160, after: 80 },
    })
  );

  const meaning = entry.meaning || entry.translation;
  if (meaning) {
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({ text: '释义:', bold: true, size: 22, color: '333333' }),
          new TextRun({ text: ` ${meaning}`, size: 22 }),
        ],
        spacing: { after: 60 },
        indent: { left: convertInchesToTwip(0.15) },
      })
    );
  }

  if (entry.contextual) {
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({ text: '语境释义:', bold: true, size: 22, color: '333333' }),
          new TextRun({ text: ` ${entry.contextual}`, size: 22 }),
        ],
        spacing: { after: 60 },
        indent: { left: convertInchesToTwip(0.15) },
      })
    );
  }

  if (entry.context) {
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({ text: '原句:', bold: true, size: 22, color: '333333' }),
          new TextRun({ text: ` "${entry.context}"`, italics: true, size: 22, color: '444444' }),
        ],
        spacing: { after: 60 },
        indent: { left: convertInchesToTwip(0.15) },
      })
    );
  }

  const fromParts: string[] = [];
  const vn = videoFileName(entry.videoPath);
  if (vn) fromParts.push(vn);
  const ts = formatTime(entry.sentenceStartMs);
  if (ts) fromParts.push(ts);
  if (fromParts.length) {
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `出处:${fromParts.join(' · ')}`,
            size: 18,
            color: '999999',
          }),
        ],
        spacing: { after: 80 },
        indent: { left: convertInchesToTwip(0.15) },
      })
    );
  }

  // 用一条底边线作为条目分隔,打印出来更清爽
  paragraphs.push(
    new Paragraph({
      spacing: { after: 120 },
      border: {
        bottom: {
          color: 'DDDDDD',
          space: 1,
          style: BorderStyle.SINGLE,
          size: 6,
        },
      },
    })
  );

  return paragraphs;
}

/**
 * 触发浏览器下载,Electron 渲染进程里也能直接用。
 */
function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 稍后再回收,给浏览器留点时间启动下载
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * 导出生词本为 Word(.docx)文档。
 * 排版:A4 纵向页面,顶部大标题 + 副标题(日期 + 总数),下面逐条列出,适合直接打印。
 */
export async function exportWordsToDocx(words: WordEntry[]): Promise<void> {
  if (!words.length) return;

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const dateStr = `${y}-${m}-${d}`;

  const titleParagraph = new Paragraph({
    alignment: AlignmentType.CENTER,
    heading: HeadingLevel.TITLE,
    spacing: { after: 120 },
    children: [new TextRun({ text: '生词本', bold: true, size: 48 })],
  });

  const subtitleParagraph = new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 320 },
    children: [
      new TextRun({
        text: `导出日期:${dateStr} ${hh}:${mm}  ·  共 ${words.length} 个单词`,
        size: 20,
        color: '888888',
      }),
    ],
  });

  const bodyParagraphs = words.flatMap((w, i) => buildWordParagraphs(w, i));

  const doc = new Document({
    creator: 'Video Learner',
    title: '生词本',
    styles: {
      default: {
        document: {
          run: { font: 'PingFang SC', size: 22 },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: 'word-list',
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.PORTRAIT },
            margin: {
              top: convertInchesToTwip(0.8),
              bottom: convertInchesToTwip(0.8),
              left: convertInchesToTwip(0.8),
              right: convertInchesToTwip(0.8),
            },
          },
        },
        children: [titleParagraph, subtitleParagraph, ...bodyParagraphs],
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  triggerDownload(blob, `生词本-${dateStr}.docx`);
}
