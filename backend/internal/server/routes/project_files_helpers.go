package routes

import (
	"context"
	"fmt"
	"mime/multipart"

	"github.com/OFFIS-RIT/kiwi/backend/internal/storage"
	"github.com/OFFIS-RIT/kiwi/backend/internal/util"
	pgdb "github.com/OFFIS-RIT/kiwi/backend/pkg/db/pgx"
	"github.com/OFFIS-RIT/kiwi/backend/pkg/ids"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type uploadedProjectFile struct {
	Name string
	Key  string
}

func uploadProjectFiles(ctx context.Context, s3Client *s3.Client, projectID string, uploads []*multipart.FileHeader) ([]uploadedProjectFile, error) {
	files := make([]uploadedProjectFile, 0, len(uploads))
	for _, file := range uploads {
		src, err := file.Open()
		if err != nil {
			return nil, err
		}

		fileID := ids.New()

		key, err := storage.PutFile(ctx, s3Client, fmt.Sprintf("projects/%s/files", projectID), file.Filename, fileID, src)
		_ = src.Close()
		if err != nil {
			return nil, err
		}

		files = append(files, uploadedProjectFile{Name: file.Filename, Key: key})
	}

	return files, nil
}

func createProjectFiles(ctx context.Context, qtx *pgdb.Queries, projectID string, files []uploadedProjectFile) ([]pgdb.ProjectFile, error) {
	projectFiles := make([]pgdb.ProjectFile, 0, len(files))
	for _, file := range files {
		projectFile, err := qtx.AddFileToProject(ctx, pgdb.AddFileToProjectParams{
			ID:        ids.New(),
			ProjectID: projectID,
			Name:      file.Name,
			FileKey:   file.Key,
		})
		if err != nil {
			return nil, err
		}
		if err := qtx.AddProjectUpdate(ctx, pgdb.AddProjectUpdateParams{
			ID:            ids.New(),
			ProjectID:     projectID,
			UpdateType:    "add_file",
			UpdateMessage: util.ConvertStructToJson(projectFile),
		}); err != nil {
			return nil, err
		}
		projectFiles = append(projectFiles, projectFile)
	}

	return projectFiles, nil
}
