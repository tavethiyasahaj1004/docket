import { RobotIcon } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { LocalDateTime } from "@/components/common/local-datetime";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AdminPendingAction } from "@/lib/mcp/pending-actions";

/** Requests an AI assistant made that are still waiting for the token owner.
 * Read-only on purpose: only the owner can approve or dismiss one, and an admin
 * never sees what a reply says. */
export function McpPendingActionsList({
  actions,
}: {
  actions: AdminPendingAction[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Awaiting approval</CardTitle>
        <CardDescription>
          Closes and replies an AI assistant has asked for. Each one waits for
          the person who owns the token to approve or dismiss it, and expires
          after 24 hours.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {actions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <RobotIcon className="size-8 text-base-content-muted mb-3" />
            <p className="text-sm font-medium text-base-content">
              Nothing is waiting for approval
            </p>
            <p className="text-xs text-base-content-muted mt-1">
              Requests from AI assistants appear here until their owner decides.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ticket</TableHead>
                <TableHead>Request</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Requested</TableHead>
                <TableHead>Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {actions.map((action) => (
                <TableRow key={action.id}>
                  <TableCell className="max-w-xs whitespace-normal">
                    <Link
                      className="font-medium text-base-content hover:underline"
                      href={`/tickets/${action.ticketNumber}`}
                    >
                      #{action.ticketNumber}
                    </Link>
                    <p className="truncate text-xs text-base-content-muted">
                      {action.ticketSubject}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {action.kind === "close" ? "Close ticket" : "Send reply"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <p className="font-medium text-base-content">
                      {action.ownerName}
                    </p>
                    <p className="text-xs text-base-content-muted">
                      {action.ownerEmail}
                    </p>
                  </TableCell>
                  <TableCell className="text-base-content-muted">
                    <LocalDateTime date={action.createdAt} />
                  </TableCell>
                  <TableCell className="text-base-content-muted">
                    <LocalDateTime date={action.expiresAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
