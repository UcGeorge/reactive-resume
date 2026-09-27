import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	BinocularsIcon,
	BrainIcon,
	BriefcaseIcon,
	ChartLineUpIcon,
	ChatCircleDotsIcon,
	ChatsCircleIcon,
	EnvelopeSimpleIcon,
	GearSixIcon,
	InfoIcon,
	KeyIcon,
	MagnifyingGlassIcon,
	ReadCvLogoIcon,
	SealCheckIcon,
	ShieldCheckIcon,
	UserCircleIcon,
	UserGearIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Avatar, AvatarFallback, AvatarImage } from "@reactive-resume/ui/components/avatar";
import { BrandIcon } from "@reactive-resume/ui/components/brand-icon";
import { Kbd } from "@reactive-resume/ui/components/kbd";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	SidebarSeparator,
} from "@reactive-resume/ui/components/sidebar";
import { getInitials } from "@reactive-resume/utils/string";
import { useCommandPaletteStore } from "@/features/command-palette/store";
import { UserDropdownMenu } from "@/features/user/dropdown-menu";

type SidebarItem = {
	icon: React.ReactNode;
	label: MessageDescriptor;
	href: React.ComponentProps<typeof Link>["to"];
};

const appSidebarItems = [
	{
		icon: <ReadCvLogoIcon />,
		label: msg`Resumes`,
		href: "/dashboard/resumes",
	},
	{
		icon: <BriefcaseIcon />,
		label: msg`Applications`,
		href: "/dashboard/applications",
	},
	{
		icon: <EnvelopeSimpleIcon />,
		label: msg`Cover Letters`,
		href: "/dashboard/cover-letters",
	},
	{
		icon: <BinocularsIcon />,
		label: msg`Discover`,
		href: "/dashboard/discover",
	},
	{
		icon: <ChatsCircleIcon />,
		label: msg`Interviews`,
		href: "/dashboard/interviews",
	},
	{
		icon: <ChartLineUpIcon />,
		label: msg`Insights`,
		href: "/dashboard/insights",
	},
	{
		icon: <ChatCircleDotsIcon />,
		label: msg`Agents`,
		href: "/agent",
	},
	{
		icon: <SealCheckIcon />,
		label: msg`ATS Checker`,
		href: "/ats-checker",
	},
] as const satisfies SidebarItem[];

const settingsSidebarItems = [
	{
		icon: <UserCircleIcon />,
		label: msg`Profile`,
		href: "/dashboard/settings/profile",
	},
	{
		icon: <GearSixIcon />,
		label: msg`Preferences`,
		href: "/dashboard/settings/preferences",
	},
	{
		icon: <ShieldCheckIcon />,
		label: msg`Authentication`,
		href: "/dashboard/settings/authentication",
	},
	{
		icon: <KeyIcon />,
		label: msg`API Keys`,
		href: "/dashboard/settings/api-keys",
	},
	{
		icon: <BrainIcon />,
		label: msg`Integrations`,
		href: "/dashboard/settings/integrations",
	},
	{
		icon: <UserGearIcon />,
		label: msg`Account`,
		href: "/dashboard/settings/account",
	},
	{
		icon: <InfoIcon />,
		label: msg`About`,
		href: "/dashboard/settings/about",
	},
] as const satisfies SidebarItem[];

type SidebarItemListProps = {
	items: readonly SidebarItem[];
};

function SidebarItemList({ items }: SidebarItemListProps) {
	const { i18n } = useLingui();

	return (
		<SidebarMenu>
			{items.map((item) => (
				<SidebarMenuItem key={item.href}>
					<SidebarMenuButton
						title={i18n.t(item.label)}
						render={
							<Link to={item.href} activeProps={{ className: "bg-sidebar-accent" }}>
								{item.icon}
								<span className="shrink-0 transition-[margin,opacity] duration-200 ease-in-out group-data-[collapsible=icon]:-ms-8 group-data-[collapsible=icon]:opacity-0">
									{i18n.t(item.label)}
								</span>
							</Link>
						}
					/>
				</SidebarMenuItem>
			))}
		</SidebarMenu>
	);
}

function SidebarSearchButton() {
	const { i18n } = useLingui();
	const setOpen = useCommandPaletteStore((state) => state.setOpen);

	const label = i18n.t(msg`Search`);

	return (
		<SidebarMenuItem>
			<SidebarMenuButton title={label} tooltip={label} onClick={() => setOpen(true)}>
				<MagnifyingGlassIcon />
				<span className="flex-1 text-start transition-[margin,opacity] duration-200 ease-in-out group-data-[collapsible=icon]:-ms-8 group-data-[collapsible=icon]:opacity-0">
					{label}
				</span>
				<Kbd className="transition-opacity duration-200 ease-in-out group-data-[collapsible=icon]:opacity-0">⌘K</Kbd>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

export function DashboardSidebar() {
	const { i18n } = useLingui();

	return (
		<Sidebar variant="floating" collapsible="icon">
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							className="h-auto justify-center"
							render={
								<Link to="/">
									<BrandIcon variant="icon" className="size-6" />
									<h1 className="sr-only">Reactive Resume</h1>
								</Link>
							}
						/>
					</SidebarMenuItem>

					<SidebarSearchButton />
				</SidebarMenu>
			</SidebarHeader>

			<SidebarSeparator />

			<SidebarContent aria-label={i18n.t(msg`Dashboard`)} role="navigation">
				<SidebarGroup>
					<SidebarGroupLabel>
						<Trans>App</Trans>
					</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarItemList items={appSidebarItems} />
					</SidebarGroupContent>
				</SidebarGroup>

				<SidebarGroup>
					<SidebarGroupLabel>
						<Trans>Settings</Trans>
					</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarItemList items={settingsSidebarItems} />
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>

			<SidebarSeparator />

			<SidebarFooter className="gap-y-0">
				<SidebarMenu>
					<SidebarMenuItem>
						<UserDropdownMenu>
							{({ session }) => (
								<SidebarMenuButton className="h-auto gap-x-3 group-data-[collapsible=icon]:p-1!">
									<Avatar className="size-8 shrink-0 transition-all group-data-[collapsible=icon]:size-6">
										<AvatarImage src={session.user.image ?? undefined} />
										<AvatarFallback className="group-data-[collapsible=icon]:text-[0.5rem]">
											{getInitials(session.user.name)}
										</AvatarFallback>
									</Avatar>

									<div className="transition-[margin,opacity] duration-200 ease-in-out group-data-[collapsible=icon]:-ms-8 group-data-[collapsible=icon]:opacity-0">
										<p className="font-medium">{session.user.name}</p>
										<p className="text-muted-foreground text-xs">{session.user.email}</p>
									</div>
								</SidebarMenuButton>
							)}
						</UserDropdownMenu>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>

			<SidebarRail />
		</Sidebar>
	);
}
