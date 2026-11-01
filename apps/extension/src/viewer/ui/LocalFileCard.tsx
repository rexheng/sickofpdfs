import { Icon, TextButton } from '@sop/ui';
import styles from './cards.module.css';
import { useFilePicker } from './FilePicker';

export interface LocalFileCardProps {
  onChooseFile: (file: File) => void;
}

/**
 * A viewer address that names a file on this computer, in a tab that was not seen opening that file (a web page may
 * have sent the tab here). The file is not read; the owner can pick it themselves.
 */
export function LocalFileCard({ onChooseFile }: LocalFileCardProps) {
  const picker = useFilePicker(onChooseFile);
  return (
    <div className={styles.stage}>
      <section className={styles.card} aria-labelledby="local-file-title">
        <Icon name="lock" className={styles.icon} />
        <h1 id="local-file-title" className={styles.title}>
          Choose the file yourself
        </h1>
        <p className={styles.body}>This link asks to show a file from your computer.</p>
        <p className={styles.body}>To keep your files safe, open the file yourself.</p>
        <div className={styles.actions}>
          <TextButton label="Choose file" onClick={picker.open} />
        </div>
        {picker.input}
      </section>
    </div>
  );
}
