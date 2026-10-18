// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Bell, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import styles from "@/components/login/login.module.css";
import { AnnouncementCard as SharedAnnouncementCard } from "@/components/notifications/announcement-card";
import {
  type Announcement,
  type AnnouncementText,
  parseAnnouncementBody,
  pickAnnouncementText,
  useAnnouncementReadState,
  useAnnouncements,
} from "./announcements";

/**
 * The announcement entry in the login page top bar: icon + unread red dot; clicking opens the announcement center.
 *
 * The top-bar red dot is tied to the unread state. Opening the announcement center counts as having seen the current list; when a new announcement appears later,
 * its new ID is not in the locally stored read set, so the red dot naturally reappears.
 *
 * When there is no announcement to show (not fetched yet / fetch failed / the OSS really is empty) the horn is still there, just without a red dot,
 * and opening it shows an empty dialog: a failed fetch is not worth putting a "Reload" button for people to press - refreshing the login page starts over anyway.
 *
 * The dialog uses Base UI's Dialog primitive instead of a hand-rolled portal: focus trap, focus returning to the trigger after close,
 * and background scroll lock are all handled by it. The motion is CSS
 * transitions on data-starting-style / data-ending-style, so prefers-reduced-motion can really switch it off - framer-motion's JS animation cannot be switched off.
 */
export function AnnouncementEntry() {
  const { t, i18n } = useTranslation();
  const announcements = useAnnouncements();
  const ids = useMemo(() => announcements.map((item) => item.id), [announcements]);
  const { isRead, markAllRead, unreadCount } = useAnnouncementReadState();
  const [open, setOpen] = useState(false);

  const unread = unreadCount(ids);

  useEffect(() => {
    if (open && ids.length > 0) markAllRead(ids);
  }, [ids, markAllRead, open]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <div className={styles.announcement}>
        <Dialog.Trigger
          className={styles.announcementTrigger}
          aria-label={t("loginCinematic.announcement.open")}
        >
          <span className={styles.announcementIcon} aria-hidden="true">
            <Bell />
            {unread > 0 ? <span className={styles.announcementDot} /> : null}
          </span>
          <span>{t("loginCinematic.announcement.label")}</span>
        </Dialog.Trigger>
      </div>

      <Dialog.Portal>
        <Dialog.Backdrop className={styles.announcementOverlay} />
        <Dialog.Popup className={styles.announcementDialog}>
          <header className={styles.announcementHeader}>
            <Dialog.Title className={styles.announcementHeading}>
              {t("loginCinematic.announcement.title")}
            </Dialog.Title>
            {unread > 0 ? (
              <span className={styles.announcementCount}>
                {t("loginCinematic.announcement.unread", { n: unread })}
              </span>
            ) : null}
            <Dialog.Close
              className={styles.announcementClose}
              aria-label={t("loginCinematic.announcement.close")}
            >
              <X strokeWidth={1.8} aria-hidden="true" />
            </Dialog.Close>
          </header>

          <div className={styles.announcementBody}>
            {/* With no announcements it is just an empty dialog: better to say nothing than write "No announcements for now". */}
            <ul className={styles.announcementList}>
              {announcements.map((item) => (
                <AnnouncementListItem
                  key={item.id}
                  announcement={item}
                  text={pickAnnouncementText(item, i18n.language)}
                  read={isRead(item.id)}
                />
              ))}
            </ul>
          </div>

          <footer className={styles.announcementFooter}>
            <button
              type="button"
              className={styles.announcementMarkAll}
              disabled={unread === 0}
              onClick={() => markAllRead(ids)}
            >
              {t("loginCinematic.announcement.markAllRead")}
            </button>
            <Dialog.Close
              className={styles.announcementConfirm}
              onClick={() => markAllRead(ids)}
            >
              {t("loginCinematic.announcement.confirm")}
            </Dialog.Close>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AnnouncementListItem({
  announcement,
  text,
  read,
}: {
  announcement: Announcement;
  text: AnnouncementText;
  read: boolean;
}) {
  const { t, i18n } = useTranslation();

  // The <time>/<hl> in the body are marked by the copy itself, so the highlight position follows the word order instead of a hard-coded index.
  const tokens = useMemo(() => parseAnnouncementBody(text.body), [text.body]);

  return (
    <li>
      <SharedAnnouncementCard
        title={text.title}
        body={text.body}
        bodyTokens={tokens}
        publishedAt={announcement.publishedAt}
        locale={i18n.language}
        unread={!read}
        badge={
          announcement.pinned ? t("loginCinematic.announcement.pinned") : undefined
        }
      />
    </li>
  );
}
