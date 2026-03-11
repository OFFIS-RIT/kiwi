"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useLanguage } from "@/providers/LanguageProvider";
import { useNavigation } from "@/providers/NavigationProvider";

export function BreadcrumbNav() {
  const {
    selectedGroup,
    selectedProject,
    selectItem,
    showAllGroups,
    showGroups,
  } = useNavigation();
  const { t } = useLanguage();

  return (
    <Breadcrumb className="min-w-0 w-full overflow-hidden">
      <BreadcrumbList className="min-w-0 w-full flex-nowrap overflow-hidden">
        {showAllGroups ? (
          <BreadcrumbItem className="shrink-0">
            <BreadcrumbPage>KIWI</BreadcrumbPage>
          </BreadcrumbItem>
        ) : selectedGroup ? (
          <>
            <BreadcrumbItem className="shrink-0">
              <BreadcrumbLink
                className="max-w-full truncate"
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  showGroups();
                }}
              >
                KIWI
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="shrink-0" />
            <BreadcrumbItem className="min-w-0 shrink">
              <BreadcrumbLink
                className="block max-w-full truncate"
                href="#"
                title={selectedGroup.name}
                onClick={(e) => {
                  e.preventDefault();
                  selectItem(selectedGroup);
                }}
              >
                {selectedGroup.name}
              </BreadcrumbLink>
            </BreadcrumbItem>
            {selectedProject && (
              <>
                <BreadcrumbSeparator className="shrink-0" />
                <BreadcrumbItem className="min-w-0 shrink">
                  <BreadcrumbPage
                    className="block max-w-full truncate"
                    title={selectedProject.name}
                  >
                    {selectedProject.name}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </>
        ) : (
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="block max-w-full truncate">
              {t("select.group")}
            </BreadcrumbPage>
          </BreadcrumbItem>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
