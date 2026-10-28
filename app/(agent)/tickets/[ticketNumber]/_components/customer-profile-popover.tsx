"use client";

import Link from "next/link";
import { useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { toast } from "sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { formatTicketDateTime } from "@/lib/tickets";
import { getInitials } from "@/lib/utils";

interface CustomerTicketSummary {
  createdAt: string;
  id: string;
  status: string;
  subject: string;
  ticketNumber: number;
}

interface CustomerProfile {
  closedTickets: CustomerTicketSummary[];
  email: string;
  frequency: Array<{ month: string; label: string; count: number }>;
  id: string;
  name: string;
  note: string | null;
  openTickets: CustomerTicketSummary[];
}

interface Props {
  children: React.ReactNode;
  currentTicketId?: string;
  customerEmail: string;
  customerId: string;
  customerName: string;
}

export function CustomerProfilePopover({
  children,
  customerId,
  customerName,
  customerEmail,
  currentTicketId,
}: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next && !profile && !loading) {
      setLoading(true);
      try {
        const res = await fetch(`/api/customers/${customerId}`);
        if (res.ok) {
          const data = (await res.json()) as CustomerProfile;
          setProfile(data);
          setNote(data.note ?? "");
        } else {
          toast.error("Failed to load customer.");
        }
      } catch {
        toast.error("Network error.");
      } finally {
        setLoading(false);
      }
    }
  }

  async function handleSaveNote() {
    setSaving(true);
    try {
      const res = await fetch(`/api/customers/${customerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (res.ok) {
        const updated = (await res.json()) as { note: string | null };
        setProfile((p) => (p ? { ...p, note: updated.note } : p));
        toast.success("Note saved.");
      } else {
        toast.error("Failed to save note.");
      }
    } catch {
      toast.error("Network error.");
    } finally {
      setSaving(false);
    }
  }

  const noteDirty = profile !== null && note !== (profile.note ?? "");

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-96 max-h-[32rem] overflow-y-auto"
      >
        <div className="flex items-start gap-3">
          <div className="size-10 rounded-full bg-primary text-primary-content flex items-center justify-center text-sm font-medium shrink-0">
            {getInitials(customerName)}
          </div>
          <div className="min-w-0 pt-0.5">
            <p className="text-sm font-medium text-base-content truncate">
              {customerName}
            </p>
            <p className="text-xs text-base-content-muted truncate">
              {customerEmail}
            </p>
          </div>
        </div>

        {loading && (
          <p className="text-xs text-base-content-muted mt-4">Loading…</p>
        )}

        {profile && (
          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-base-content-muted">
                Note
              </span>
              <Textarea
                className="min-h-16 text-xs"
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add a note about this customer…"
                value={note}
              />
              {noteDirty && (
                <button
                  className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                  disabled={saving}
                  onClick={handleSaveNote}
                  type="button"
                >
                  {saving ? "Saving…" : "Save note"}
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <TicketList
                currentTicketId={currentTicketId}
                tickets={profile.openTickets}
                title={`Open tickets (${profile.openTickets.length})`}
              />
              <TicketList
                currentTicketId={currentTicketId}
                tickets={profile.closedTickets}
                title={`Closed tickets (${profile.closedTickets.length})`}
              />
            </div>

            <div>
              <span className="text-xs font-medium text-base-content-muted">
                Frequency
              </span>
              <div className="h-28 mt-1">
                <ResponsiveContainer height="100%" width="100%">
                  <BarChart data={profile.frequency}>
                    <XAxis
                      axisLine={false}
                      dataKey="label"
                      fontSize={10}
                      interval={0}
                      stroke="var(--base-content-muted)"
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--base-100)",
                        border: "1px solid var(--base-300)",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                      cursor={{ fill: "var(--base-300)" }}
                      labelFormatter={(_label, payload) =>
                        payload?.[0]?.payload?.month ?? ""
                      }
                    />
                    <Bar
                      dataKey="count"
                      fill="var(--primary)"
                      radius={[3, 3, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function TicketList({
  title,
  tickets,
  currentTicketId,
}: {
  title: string;
  tickets: CustomerTicketSummary[];
  currentTicketId?: string;
}) {
  return (
    <div className="min-w-0">
      <span className="text-2xs font-medium text-base-content-muted uppercase tracking-wide">
        {title}
      </span>
      {tickets.length === 0 ? (
        <p className="text-xs text-base-content-muted mt-1.5">None</p>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {tickets.slice(0, 5).map((t) => (
            <li key={t.id}>
              <Link
                className={`block text-xs truncate hover:underline ${
                  t.id === currentTicketId
                    ? "text-base-content-muted"
                    : "text-base-content"
                }`}
                href={`/tickets/${t.ticketNumber}`}
                title={t.subject}
              >
                {t.subject}
              </Link>
              <span className="text-2xs text-base-content-muted">
                {formatTicketDateTime(new Date(t.createdAt))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
