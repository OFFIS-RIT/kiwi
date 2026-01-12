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
    <Breadcrumb>
      <BreadcrumbList>
        {showAllGroups ? (
          <BreadcrumbItem>
            <BreadcrumbPage>KIWI</BreadcrumbPage>
          </BreadcrumbItem>
        ) : selectedGroup ? (
          <>
            <BreadcrumbItem>
              <BreadcrumbLink
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  showGroups();
                }}
              >
                KIWI
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink
                href="#"
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
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{selectedProject.name}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </>
        ) : (
          <BreadcrumbItem>
            <BreadcrumbPage>{t("select.group")}</BreadcrumbPage>
          </BreadcrumbItem>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
