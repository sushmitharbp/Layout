import os
import json
import time
import uuid
from datetime import datetime

LOCAL_NOTIFICATIONS_FILE = "data_notifications_store.json"

class NotificationEngine:
    """
    Real-time Notification Engine for Material Order Workflow transitions:
    - Alerts receiving teams when new MOs are created and routed to them
    - Alerts teams when an MO moves across stages (Krysalis -> Purchase -> ERP)
    - Alerts Shearing when an MO is rejected (with reason & actor)
    - Alerts Shearing when an MO is approved and released to live ERP
    - Alerts target review team when Shearing resubmits a rejected MO
    """

    def __init__(self, filepath=LOCAL_NOTIFICATIONS_FILE):
        self.filepath = filepath
        self._ensure_store()

    def _ensure_store(self):
        if not os.path.exists(self.filepath):
            try:
                with open(self.filepath, "w", encoding="utf-8") as f:
                    json.dump([], f, indent=2)
            except Exception as e:
                print(f"[Notifications] Error initializing notifications store: {e}")

    def _load_notifications(self):
        try:
            if os.path.exists(self.filepath):
                with open(self.filepath, "r", encoding="utf-8") as f:
                    return json.load(f)
            return []
        except Exception as e:
            print(f"[Notifications] Error loading notifications: {e}")
            return []

    def _save_notifications(self, notifs):
        try:
            # Cap store to 500 records to prevent memory/file bloat
            if len(notifs) > 500:
                notifs = notifs[:500]
            with open(self.filepath, "w", encoding="utf-8") as f:
                json.dump(notifs, f, indent=2)
        except Exception as e:
            print(f"[Notifications] Error saving notifications: {e}")

    def create_notification(self, target_role, notif_type, mo_number, title, message, sender_role="system", sender_name="System", priority="normal", extra_data=None):
        """
        Creates and stores a targeted notification.
        :param target_role: 'shearing', 'krysalis', 'purchase', 'erp', or 'all'
        :param notif_type: 'MO_CREATED', 'MO_ROUTED', 'MO_REJECTED', 'MO_APPROVED', 'MO_RESUBMITTED'
        :param mo_number: The MO ID (e.g. 'MO-2026-00042')
        :param title: Short title e.g. 'Action Required: MO Received'
        :param message: Full explanatory message
        :param priority: 'normal', 'urgent' (for rejection), 'success' (for approval)
        """
        now_iso = datetime.utcnow().isoformat() + "Z"
        notif_id = f"notif_{int(time.time()*1000)}_{uuid.uuid4().hex[:6]}"

        record = {
            "id": notif_id,
            "target_role": (target_role or "all").lower().strip(),
            "type": notif_type,
            "mo_number": mo_number,
            "title": title,
            "message": message,
            "sender_role": (sender_role or "system").lower().strip(),
            "sender_name": sender_name or "System",
            "priority": priority or "normal",
            "created_at": now_iso,
            "read_by": [],
            "extra_data": extra_data or {}
        }

        notifs = self._load_notifications()
        notifs.insert(0, record)
        self._save_notifications(notifs)
        return record

    def get_notifications_for_role(self, role, limit=50):
        """
        Fetches notifications intended for the given role, along with live unread counts.
        """
        role_lower = (role or "").lower().strip()
        all_notifs = self._load_notifications()
        filtered = []

        for n in all_notifs:
            tgt = (n.get("target_role") or "").lower()
            if tgt == role_lower or tgt == "all":
                # For Purchase team, strictly only show notifications for MOs that come for Purchase approval (not endbits or direct-ERP)
                if role_lower == "purchase":
                    extra = n.get("extra_data") or {}
                    if extra.get("is_endbit") or (extra.get("stage") and extra.get("stage") != "PURCHASE"):
                        continue

                is_read = role_lower in n.get("read_by", [])
                filtered.append({
                    **n,
                    "is_read": is_read
                })

        unread_count = sum(1 for n in filtered if not n.get("is_read"))
        return {
            "notifications": filtered[:limit],
            "unread_count": unread_count,
            "total_count": len(filtered)
        }

    def mark_as_read(self, role, notif_id=None):
        """
        Marks a specific notification or all notifications as read for the role.
        """
        if notif_id in (None, "", "null", "undefined"):
            notif_id = None

        role_lower = (role or "").lower().strip()
        all_notifs = self._load_notifications()
        updated = False

        for n in all_notifs:
            tgt = (n.get("target_role") or "").lower()
            if not role_lower or tgt == role_lower or tgt == "all":
                tag = role_lower if role_lower else tgt
                read_by = n.get("read_by", [])
                if notif_id:
                    if str(n.get("id")) == str(notif_id):
                        if tag not in read_by:
                            read_by.append(tag)
                            n["read_by"] = read_by
                            updated = True
                        break
                else:
                    if tag not in read_by:
                        read_by.append(tag)
                        n["read_by"] = read_by
                        updated = True

        if updated:
            self._save_notifications(all_notifs)
        return True

    def clear_notifications_for_role(self, role):
        """
        Marks all notifications as read for the role.
        """
        return self.mark_as_read(role, notif_id=None)
