import * as React from "react";
import { Body, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text } from "react-email";

// ponytail: server dev consumes this source through tsx, which emits React.createElement here.
void React;

export type FollowUpDigestItem = {
	company: string;
	role: string;
	dueAt: string;
	note: string | null;
};

export type FollowUpDigestProps = {
	name: string;
	items: FollowUpDigestItem[];
	appUrl: string;
};

/** The daily follow-up digest: due follow-ups only, one line each, linking back to the
 * Applications page. Opt-in per user and only sent when the instance has SMTP configured. */
export function FollowUpDigestEmail({ name, items, appUrl }: FollowUpDigestProps) {
	const queueUrl = `${appUrl}/dashboard/applications?view=followups`;
	return (
		<Html lang="en">
			<Head />
			<Preview>{`${items.length} follow-up${items.length === 1 ? "" : "s"} due today`}</Preview>
			<Body style={{ fontFamily: "sans-serif", backgroundColor: "#ffffff", color: "#111111" }}>
				<Container style={{ padding: "24px", maxWidth: "560px" }}>
					<Heading as="h2">Follow-ups due</Heading>
					<Text>
						Hi {name} — {items.length === 1 ? "one application is" : `${items.length} applications are`} waiting on a
						follow-up:
					</Text>
					<Section>
						{items.map((item) => (
							<Text key={`${item.company}-${item.role}-${item.dueAt}`} style={{ margin: "4px 0" }}>
								• <strong>{item.role}</strong> at {item.company} — due {item.dueAt}
								{item.note ? ` (${item.note})` : ""}
							</Text>
						))}
					</Section>
					<Hr />
					<Text>
						<Link href={queueUrl}>Open the follow-up queue</Link> to draft, complete or snooze them. You can turn this
						digest off in your career settings.
					</Text>
				</Container>
			</Body>
		</Html>
	);
}
