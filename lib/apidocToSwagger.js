var _ = require("lodash");
var { pathToRegexp } = require("path-to-regexp");
var html2markdown = require("html2markdown");
var jsonlint = require("jsonlint");
const { camelCase } = require("lodash");

var swagger = {
  openapi: "3.0.3",
  info: {},
  servers: [],
  tags: {},
  paths: {},
  components: {
    securitySchemes: {},
    schemas: {},
  },
  security: [{}],
  //securityComponents: {},
  "x-permissions": {},
  servers: {},
  "x-tagGroups": {},
};

/**
 * Simple object check.
 * @param item
 * @returns {boolean}
 */
function isObject(item) {
  return item && typeof item === "object" && !Array.isArray(item);
}

/**
 * Deep merge two objects.
 * @param target
 * @param ...sources
 */
function mergeDeep(target, ...sources) {
  if (!sources.length) return target;
  const source = sources.shift();

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        mergeDeep(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }

  return mergeDeep(target, ...sources);
}

function getMimeFromType(type) {
  switch (type) {
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    case "txt":
      return "text/plain";
    case "xml":
      return "text/xml";
    default:
      if (type.startsWith("application/")) {
        return type;
      }
      if (type.startsWith("audio/")) {
        return type;
      }
      console.log("Unexpected application type: " + type);
      return "application/unknown";
  }
}

function toSwagger(apidocJson, projectJson, swaggerInit) {
  swagger.info = addInfo(projectJson);
  swagger.paths = extractPaths(apidocJson);

  // rename old x-servers to servers
  if (swaggerInit["x-servers"]) {
    swaggerInit["servers"] = swaggerInit["x-servers"];
    delete swaggerInit["x-servers"];
  }
  swagger = mergeDeep(swagger, swaggerInit);

  // Check Tags
  Object.values(tags).forEach((t) => {
    if (!swagger.tags.some((st) => st.name === t)) {
      console.error(
        `\x1b[31merror:\x1b[0m Operation tags "${t}" must be defined in global tags.`
      );
    }
  });

  // Sort tags
  swagger.tags = swagger.tags.sort((a, b) =>
    ("" + a.name).localeCompare(b.name)
  );

  // Check Tag Groups
  swagger.tags.forEach((t) => {
    if (!swagger["x-tagGroups"].some((tg) => tg.tags.includes(t))) {
      console.error(
        `\x1b[33mwarn:\x1b[0m Operation tags "${t.name}" does not belong to a group in "x-tagGroups".`
      );
    }
  });

  // Clean up unused elements
  if (!Object.keys(swagger.components.securitySchemes).length) {
    delete swagger.components.securitySchemes;
  }
  if (!Object.keys(swagger["x-permissions"]).length) {
    delete swagger["x-permissions"];
  }

  return swagger;
}

var tagsRegex = /(<(\S[^>]+)>)/gi;
// Removes <p> </p> tags from text
function removeTags(text) {
  //return text ? text.replace(tagsRegex, "") : text;
  return text ? text.replace(/<p>/, "").replace(/<\p>/, "") : text;
}

function removeTagsWithHtml2markdown(value) {
  if (process.env.PURE_MD) return value;
  try {
    return removeTags(html2markdown(value));
  } catch (err) {
    return value;
  }
}

function addInfo(projectJson) {
  var info = {};
  info["title"] = projectJson.title || projectJson.name;
  info["version"] = projectJson.version;
  if (projectJson.header) {
    info["description"] = html2markdown(
      "<h1>" +
        projectJson.description +
        "</h1><p><h2>" +
        projectJson.header.title +
        "</h2></p>" +
        projectJson.header.content
    );
  } else {
    info["description"] = projectJson.description;
  }
  return info;
}

var tags = {};
function getTagFromGoup(group) {
  if (tags.hasOwnProperty(group)) {
    return tags[group];
  }

  var tag = group.replace(/_/g, " ").replace(/\w\S*/g, function (txt) {
    return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
  });
  tags[group] = tag;
  return tag;
}
/**
 * Extracts paths provided in json format
 * post, patch, put request parameters are extracted in body
 * get and delete are extracted to path parameters
 * @param apidocJson
 * @returns {{}}
 */
function extractPaths(apidocJson) {
  var apiPaths = groupByUrl(apidocJson);
  var paths = {};
  for (var i = 0; i < apiPaths.length; i++) {
    var verbs = apiPaths[i].verbs;
    var url = verbs[0].url;
    var pattern = pathToRegexp(url, null);
    var matches = pattern.exec(url);

    // Surrounds URL parameters with curly brackets -> :email with {email}
    var pathKeys = [];
    for (var j = 1; j < matches.length; j++) {
      var key = matches[j].substr(1);
      url = url.replace(matches[j], "{" + key + "}");
      pathKeys.push(key);
    }

    for (var j = 0; j < verbs.length; j++) {
      var verb = verbs[j];
      var type = verb.type;

      var obj = (paths[url] = paths[url] || {});

      if (type == "post" || type == "patch" || type == "put") {
        _.extend(
          obj,
          createPostPushPutOutput(verb, swagger.components, pathKeys)
        );
      } else {
        _.extend(
          obj,
          createGetDeleteOutput(verb, swagger.components, pathKeys)
        );
      }
    }
  }
  return paths;
}

function extractJsonFromExample(content, type, context) {
  if (type !== "json") {
    return content;
  }
  // Remove HTTP/1.1 header if present
  var result = "";
  var formattedContent = content.replace(
    /(^\s*HTTP.*$\n|^\s*\/\/.*$\n|[^\:]\/\/.*$\n)/gm,
    ""
  );

  // Multiline string treatment
  formattedContent = formattedContent.replace(
    /("(\\"|[^"]|"")*")/g,
    function (value) {
      return value.replace(/\n/g, "\\n");
    }
  );

  // Escape \
  formattedContent = formattedContent
    .replace(/\\[^"]/gm, "\\\\")
    .replace(/\\"/gm, '\\\\\\"');

  try {
    result = JSON.parse(formattedContent);
  } catch (err) {
    try {
      jsonlint.parse(formattedContent);
    } catch (error) {
      console.error(
        "Example conversion failure: " +
          context +
          " - " +
          content +
          "\n Error: " +
          error
      );
      console.error(
        "\x1b[31m%s\x1b[0m",
        "----------------------------------------------\n"
      );
    }
  }
  return result;
}

function extractAllowedValues(allowedValues, type) {
  var prop = {};

  if (allowedValues) {
    allowedValues = allowedValues.map(function (value) {
      return value.replace(/^[\"\']/, "").replace(/[\"\']$/, "");
    });

    if (allowedValues[0] && allowedValues[0].startsWith("/")) {
      prop.pattern = allowedValues[0];
    } else {
      if (
        type === "number" &&
        (allowedValues[0].includes("..") ||
          allowedValues[0].match(/-?\d+--?\d+/))
      ) {
        throw new Error(
          "Number range must be set using {number{100-999}} and not " +
            allowedValues[0]
        );
      }

      switch (type) {
        case "number":
          prop.enum = allowedValues.map(function (value) {
            return parseInt(value, 10);
          });
          break;
        case "boolean":
          prop.enum = allowedValues.map(function (value) {
            return value?.toLowerCase() === "true";
          });
          break;
        default:
          prop.enum = allowedValues;
      }
    }
  }
  return prop;
}

function extractDefaultValues(defaultValue, type) {
  var prop = {};

  if (defaultValue) {
    defaultValue = defaultValue.replace(/^[\"\']/, "").replace(/[\"\']$/, "");

    if (defaultValue && defaultValue.startsWith("/")) {
      prop.pattern =
        type === "number" ? parseInt(defaultValue, 10) : defaultValue;
    } else {
      if (type === "number") {
        prop.default = parseInt(defaultValue, 10);
      } else if (type === "string[]") {
        console.debug(
          `[extractDefaultValues] Handling string[] for defaultValue ${defaultValue}`
        );
        try {
          prop.default = JSON.parse(defaultValue);
        } catch (e) {
          console.warn(
            `[extractDefaultValues] Failed to JSON parse defaultValue ${defaultValue}, set it without parsing`
          );
          prop.default = defaultValue;
        }
      } else if (type === "boolean") {
        prop.default = defaultValue?.toLowerCase() === "true";
      } else if (type === "object[]" && defaultValue !== "undefined") {
        prop.default = defaultValue;
      } else {
        prop.default = defaultValue;
      }
    }
  }
  return prop;
}

function createPostPushPutOutput(verbs, components, pathKeys) {
  var pathItemObject = {};
  var verbDefinitionResult = createVerbComponents(verbs, components);

  var params = [];
  var requestBody;
  var pathParams = createPathParameters(verbs, pathKeys);
  pathParams = _.filter(pathParams, function (param) {
    var hasKey = pathKeys.indexOf(param.name) !== -1;
    return !(param.in === "path" && !hasKey);
  });

  params = params.concat(pathParams);
  var required =
    verbs.parameter &&
    verbs.parameter.fields &&
    ((verbs.parameter.fields.Parameter &&
      verbs.parameter.fields.Parameter.length > 0) ||
      (verbs.parameter.fields["Body Parameters"] &&
        verbs.parameter.fields["Body Parameters"].length > 0));

  // Extract Content-Type is defined in headers
  let contentTypeHeader = verbs?.header?.fields["Header"]?.find((value) =>
    ["content-type"].includes(value.field?.toLowerCase())
  );

  let contentTypes = contentTypeHeader?.allowedValues
    ? contentTypeHeader?.allowedValues
    : contentTypeHeader?.description
    ? [contentTypeHeader?.description]
    : ["application/json"];

  if (verbs.parameter && verbs.parameter.fields["Body Parameters"]) {
    requestBody = { content: {}, required: required };
    contentTypes.forEach((contentType) => {
      requestBody.content[contentType] = {
        schema: {
          $ref:
            "#/components/schemas/" +
            verbDefinitionResult.topLevelParametersRef,
        },
      };
    });
  }

  pathItemObject[verbs.type] = {
    tags: [getTagFromGoup(verbs.group)],
    summary: removeTags(verbs.title),
    description: removeTagsWithHtml2markdown(verbs.description),
    operationId: verbs.name,
    requestBody,
    parameters: params,
  };

  var security = createSecurity(verbs, swagger.components.securitySchemes);
  if (security && security.length) {
    pathItemObject[verbs.type].security = security;
  }

  var permissions = createPermission(verbs, swagger["x-permissions"]);
  if (permissions && permissions.length) {
    pathItemObject[verbs.type]["x-permissions"] = permissions;
  }

  if (verbs.deprecated) {
    pathItemObject[verbs.type].deprecated = true;
    pathItemObject[verbs.type].description = verbs.deprecated.content;
  }

  pathItemObject[verbs.type].responses = {};

  if (verbDefinitionResult.topLevelSuccessRef) {
    // Manage responses
    pathItemObject[verbs.type].responses = {};
    pathItemObject[verbs.type].responses[
      verbDefinitionResult.topLevelSuccessCode
    ] = {
      description: "successful operation",
      content: {},
    };

    let content =
      pathItemObject[verbs.type].responses[
        verbDefinitionResult.topLevelSuccessCode
      ].content;

    // manage special headers
    let contentType = "application/json";
    verbs?.success?.headers.some((value) => {
      if (["content-type"].includes(value.field?.toLowerCase())) {
        contentType = value.allowedValues[0];
        return true;
      }
      return false;
    });

    content[contentType] = {
      schema: {
        //  "type": verbDefinitionResult.topLevelSuccessRefType,
        //  "items": {
        $ref: "#/components/schemas/" + verbDefinitionResult.topLevelSuccessRef,
        //  }
      },
    };
    if (
      verbs.success &&
      verbs.success.examples &&
      verbs.success.examples.length
    ) {
      verbs.success.examples.forEach(function (element, index) {
        content[getMimeFromType(element.type)] = {
          ...content[getMimeFromType(element.type)],
          examples: {
            response: {
              summary: element.title,
              value: extractJsonFromExample(
                element.content,
                element.type,
                verbDefinitionResult.topLevelSuccessRef
              ),
            },
          },
        };
      }, this);
    }
  }

  if (
    verbDefinitionResult.topLevelErrorArray &&
    verbDefinitionResult.topLevelErrorArray.length
  ) {
    if (!pathItemObject[verbs.type].responses) {
      pathItemObject[verbs.type].responses = {};
    }
    verbDefinitionResult.topLevelErrorArray.forEach(function (item) {
      pathItemObject[verbs.type].responses[item.code] = {
        description: item.description,
      };
    });
    if (verbs.error && verbs.error.examples && verbs.error.examples.length) {
      verbs.error.examples.forEach(function (example) {
        var code = example.title.match(/\d+/)[0];
        if (code && pathItemObject[verbs.type].responses[code]) {
          if (!pathItemObject[verbs.type].responses[code].content) {
            pathItemObject[verbs.type].responses[code].content = {};
          }
          pathItemObject[verbs.type].responses[code].content[
            getMimeFromType(example.type)
          ] = {
            ...pathItemObject[verbs.type].responses[code].content[
              getMimeFromType(example.type)
            ],
            examples: {
              response: {
                summary: example.title,
                value: extractJsonFromExample(
                  example.content,
                  example.type,
                  verbDefinitionResult.topLevelSuccessRef
                ),
              },
            },
          };
        }
      });
    }
  }
  if (pathItemObject[verbs.type].parameters.length < 1) {
    delete pathItemObject[verbs.type].parameters;
  }

  if (!pathItemObject[verbs.type].description) {
    console.warn(
      `\x1b[33mwarn:\x1b[0m Operation "@apiDescription" must be present and non-empty string, for @apiName ${
        pathItemObject[verbs.type].operationId
      }`
    );
  }

  return pathItemObject;
}

function organizeSpecificSuccessFields(verbs) {
  verbs.success["headers"] = [];
  verbs.success["cookies"] = [];
  verbs.success["queries"] = [];
  verbs.success["forms"] = [];

  for (key in verbs.success.fields) {
    if (verbs.success.fields.hasOwnProperty(key)) {
      i = verbs.success.fields[key].length;
      while (i--) {
        // Reverse loop required for splice
        switch (verbs.success.fields[key][i].group.toLowerCase()) {
          case "headersresponse":
            verbs.success["headers"].push(verbs.success.fields[key][i]);
            verbs.success.fields[key].splice(i, 1);
            break;
          case "urlqueryparameters":
            verbs.success["cookies"].push(verbs.success.fields[key][i]);
            verbs.success.fields[key].splice(i, 1);
            break;
          case "cookieparameters":
            verbs.success["queries"].push(verbs.success.fields[key][i]);
            verbs.success.fields[key].splice(i, 1);
            break;
          case "formparameters":
            verbs.success["forms"].push(verbs.success.fields[key][i]);
            verbs.success.fields[key].splice(i, 1);
            break;
          default:
            break;
        }
      }
      if (verbs.success.fields[key].length === 0) {
        delete verbs.success.fields[key];
      }
    }
  }
}

function createVerbComponents(verbs, components) {
  var result = {
    topLevelParametersRef: null,
    topLevelSuccessRef: null,
    topLevelSuccessRefType: null,
    topLevelErrorArray: [],
  };
  verbs.name = camelCase(verbs.name.replace("_", " "));
  var defaultObjectName = verbs.name;

  var fieldArrayResult = {};
  if (verbs && verbs.parameter && verbs.parameter.fields) {
    var parameter =
      verbs.parameter.fields.Parameter ||
      verbs.parameter.fields["Body Parameters"];
    fieldArrayResult = createFieldArrayComponents(
      parameter,
      components,
      verbs.name,
      defaultObjectName
    );
    result.topLevelParametersRef = fieldArrayResult.topLevelRef;
  }

  if (verbs && verbs.success && verbs.success.fields) {
    organizeSpecificSuccessFields(verbs);
    if (Object.keys(verbs.success.fields).length === 1) {
      var successItem = Object.entries(verbs.success.fields)[0];
      var key = successItem[0];
      var itemValue = successItem[1];
      fieldArrayResult = createFieldArrayComponents(
        itemValue,
        components,
        verbs.name,
        defaultObjectName + (key === "Success 200" ? "" : key) + "Success"
      );

      result.topLevelSuccessRef = fieldArrayResult.topLevelRef;
      result.topLevelSuccessRefType = fieldArrayResult.topLevelRefType;
      result.topLevelSuccessCode = key === "Success 200" ? "200" : key;
      if (fieldArrayResult.topLevelRefFormat) {
        result.topLevelSuccessRefFormat = fieldArrayResult.topLevelRefFormat;
      }
    } else {
      var refArray = [];
      for (var key in verbs.success.fields) {
        if (verbs.success.fields.hasOwnProperty(key)) {
          var successItem = verbs.success.fields[key];
          fieldArrayResult = createFieldArrayComponents(
            successItem,
            components,
            verbs.name,
            defaultObjectName +
              (key === "Success 200" ? "200" : key) +
              "Success"
          );

          refArray.push(fieldArrayResult.topLevelRefType);
        }
      }

      commonResult = createOneOfComponents(
        refArray,
        components,
        defaultObjectName + "Success"
      );

      result.topLevelSuccessRef = commonResult.topLevelRef;
      result.topLevelSuccessRefType = commonResult.topLevelRefType;
      result.topLevelSuccessCode = "200";
      if (commonResult.topLevelRefFormat) {
        result.topLevelSuccessRefFormat = commonResult.topLevelRefFormat;
      }
    }
  }

  if (verbs && verbs.error && verbs.error.fields) {
    for (var key in verbs.error.fields) {
      if (verbs.error.fields.hasOwnProperty(key)) {
        var errorItem = verbs.error.fields[key];
        if (errorItem && errorItem.length) {
          for (var itemKey in errorItem) {
            if (errorItem.hasOwnProperty(itemKey)) {
              result.topLevelErrorArray.push({
                code: errorItem[itemKey].field,
                description: errorItem[itemKey].description,
              });
            }
          }
        }
      }
    }
  }

  return result;
}

function convertApiDocSimpleTypeToSwaggerType(type) {
  var _type = type.toLowerCase();

  if (_type === "string") {
    return {
      type: "string",
    };
  } else if (
    _type === "date" ||
    _type === "date-time" ||
    _type === "byte" ||
    _type === "binary" ||
    _type === "password"
  ) {
    return {
      type: "string",
      format: _type,
    };
  } else if (_type === "integer") {
    return {
      type: "integer",
      format: "int32",
    };
  } else if (_type === "long") {
    return {
      type: "integer",
      format: "int64",
    };
  } else if (_type === "float" || _type === "double") {
    return {
      type: "number",
      format: _type,
    };
  } else {
    return {
      type: _type,
    };
  }

  return prop;
}

function createFieldArrayComponents(
  fieldArray,
  components,
  topLevelRef,
  defaultObjectName
) {
  if (!fieldArray) {
    return {
      topLevelRef: topLevelRef,
    };
  }

  fieldArray.sort((a, b) => +(a.field > b.field) || -(a.field < b.field));

  var result = {
    topLevelRef: defaultObjectName,
    topLevelRefType: "#/components/schemas/" + defaultObjectName,
    topLevelRefFormat: null,
  };

  let binaryResponse = fieldArray.find((field) =>
    ["binary"].includes(field?.type?.toLowerCase())
  );
  if (binaryResponse) {
    components.schemas[defaultObjectName] = {
      type: "string",
      format: "binary",
      description: binaryResponse.description,
    };
    return result;
  }

  components.schemas[defaultObjectName] = components.schemas[
    defaultObjectName
  ] || { type: "object", properties: {} };

  for (var i = 0; i < fieldArray.length; i++) {
    var parameter = fieldArray[i];
    var nestedName = createNestedName(parameter.field);
    var objectName = nestedName.objectName;
    if (!objectName) {
      objectName = defaultObjectName;
    }
    var type = parameter.type;

    if (nestedName.propertyName) {
      var type = (parameter.type || "").toLowerCase();
      var proptype = type === "date" || type === "binary" ? "string" : type;

      var prop = {}; //{ type: proptype, description: removeTags(parameter.description) };
      if (parameter.type === "Object") {
        prop = { type: "object", properties: {} };
      } else {
        prop.type = proptype;
        prop.description = removeTagsWithHtml2markdown(parameter.description);
      }

      prop = Object.assign(
        prop,
        extractAllowedValues(parameter.allowedValues, prop.type),
        extractDefaultValues(parameter.defaultValue, prop.type),
        convertApiDocSimpleTypeToSwaggerType(type)
      );

      var typeIndex = type.indexOf("[]");
      var localDefinitionName = objectName;
      if (typeIndex !== -1 && typeIndex === type.length - 2) {
        prop.type = "array";

        var _type = type.slice(0, type.length - 2);
        if (_type === "object") {
          var localDefinitionName = camelCase(
            defaultObjectName + " " + nestedName.propertyName
          );
          prop.items = {
            $ref: "#/components/schemas/" + localDefinitionName,
          };
          components.schemas[localDefinitionName] = components.schemas[
            localDefinitionName
          ] || { type: "object", properties: {} };
        } else {
          // ********************************* correction :enum schemas ***********************************
          if (prop.hasOwnProperty("enum")) {
            prop.items = {
              enum: prop.enum,
              type: _type,
            };
            delete prop.enum;
          } else if (_type === "date-time") {
            prop.items = {
              type: "string",
              format: _type,
            };
          } else {
            prop.items = {
              type: _type,
            };
          }
        }
      }

      if (prop.type === "string") {
        if (parameter.size) {
          var sizeRegex = /^(\d*)\.\.(\d*)$/g; // ex: "4..67"
          var match = sizeRegex.exec(parameter.size);
          if (match && match[1]) {
            prop.minLength = parseInt(match[1], 10);
          }
          if (match && match[2]) {
            prop.maxLength = parseInt(match[2], 10);
          }
          if (!match && parameter.size.match(/\d+/)) {
            prop.minLength = prop.maxLength = parseInt(parameter.size, 10);
          }
        }
      }

      if (prop.type === "integer" || prop.type === "number") {
        if (parameter.size) {
          var sizeNumberRegex = /^(-?\d*)-(\d*)$/g; // ex: "4-67"
          var match = sizeNumberRegex.exec(parameter.size);
          if (match && match[1]) {
            prop.minimum = parseInt(match[1], 10);
          }
          if (match && match[2]) {
            prop.maximum = parseInt(match[2], 10);
          }
        }
      }

      if (
        nestedName.objectName &&
        !components.schemas[
          camelCase(defaultObjectName + " " + nestedName.objectName)
        ]
      ) {
        var parentObject = components.schemas[result.topLevelRef];
        nestedName.objectNames.forEach(function (value) {
          if (parentObject.properties[value]) {
            if (
              parentObject.properties[value].items &&
              parentObject.properties[value].items.$ref
            ) {
              parentObject =
                components.schemas[
                  parentObject.properties[value].items.$ref.replace(
                    "#/components/schemas/",
                    ""
                  )
                ];
            } else {
              parentObject = parentObject.properties[value];
            }
          } else {
            parentObject.properties[value] = { type: "object", properties: {} };
          }
        });
        if (parentObject.items && parentObject.items.$ref) {
          parentObject =
            components.schemas[
              parentObject.items.$ref.replace("#/components/schemas/", "")
            ];
        }

        parentObject.properties[nestedName.propertyName] = prop;
        if (!parameter.optional) {
          if (!parentObject.required) {
            parentObject.required = [];
          }
          var arr = parentObject.required;
          if (arr.indexOf(nestedName.propertyName) === -1) {
            arr.push(nestedName.propertyName);
          }
        }
      } else {
        if (
          components.schemas[
            camelCase(defaultObjectName + " " + nestedName.objectName)
          ]
        ) {
          objectName = camelCase(
            defaultObjectName + " " + nestedName.objectName
          );
        }
        components.schemas[objectName]["properties"][nestedName.propertyName] =
          prop;
        if (!parameter.optional) {
          if (!components.schemas[objectName].required) {
            components.schemas[objectName].required = [];
          }
          var arr = components.schemas[objectName].required;
          if (arr.indexOf(nestedName.propertyName) === -1) {
            arr.push(nestedName.propertyName);
          }
        }
      }
    }
  }

  return result;
}

function createOneOfComponents(refArray, components, defaultObjectName) {
  var result = {
    topLevelRef: defaultObjectName,
    topLevelRefType: "#/components/schemas/" + defaultObjectName,
    topLevelRefFormat: null,
  };

  components.schemas[defaultObjectName] = {
    oneOf: refArray.map((ref) => {
      return { $ref: ref };
    }),
  };

  return result;
}

function createNestedName(field) {
  var propertyName = field;
  var objectName;
  var propertyNames = field.split(".");
  if (propertyNames && propertyNames.length > 1) {
    propertyName = propertyNames[propertyNames.length - 1];
    propertyNames.pop();
    objectName = propertyNames.join(".");
  }

  return {
    propertyName: propertyName,
    objectName: objectName,
    objectNames: propertyNames,
  };
}

/**
 * Generate get, delete method output
 * @param verbs
 * @returns {{}}
 */
function createGetDeleteOutput(verbs, components, pathKeys) {
  var pathItemObject = {};
  verbs.type = verbs.type === "del" ? "delete" : verbs.type;

  var verbDefinitionResult = createVerbComponents(verbs, components);

  var params = [];
  var requestBody;
  var pathParams = createPathParameters(verbs, pathKeys);
  pathParams = _.filter(pathParams, function (param) {
    var hasKey = pathKeys.indexOf(param.name) !== -1;
    return !(param.in === "path" && !hasKey);
  });

  params = params.concat(pathParams);
  var required =
    verbs.parameter &&
    verbs.parameter.fields &&
    ((verbs.parameter.fields.Parameter &&
      verbs.parameter.fields.Parameter.length > 0) ||
      (verbs.parameter.fields["Body Parameters"] &&
        verbs.parameter.fields["Body Parameters"].length > 0));

  if (verbs.parameter && verbs.parameter.fields["Body Parameters"]) {
    requestBody = {
      content: {
        "application/json": {
          schema: {
            $ref:
              "#/components/schemas/" +
              verbDefinitionResult.topLevelParametersRef,
          },
        },
      },
      required: required,
    };
  }

  pathItemObject[verbs.type] = {
    tags: [getTagFromGoup(verbs.group)],
    summary: removeTags(verbs.title),
    description: removeTagsWithHtml2markdown(verbs.description),
    operationId: verbs.name,
    requestBody,
    parameters: params.concat(
      //createPathParameters(verbs),
      createHeaderParameters(verbs),
      createCookieParameters(verbs),
      createQueryParameters(verbs),
      createFormParameters(verbs)
    ),
  };

  var security = createSecurity(verbs, swagger.components.securitySchemes);
  if (security && security.length) {
    pathItemObject[verbs.type].security = security;
  }

  var permissions = createPermission(verbs, swagger["x-permissions"]);
  if (permissions && permissions.length) {
    pathItemObject[verbs.type]["x-permissions"] = permissions;
  }

  if (verbs.deprecated) {
    pathItemObject[verbs.type].deprecated = true;
    pathItemObject[verbs.type].description = verbs.deprecated.content;
  }

  if (verbDefinitionResult.topLevelSuccessRef) {
    if (
      verbDefinitionResult.topLevelSuccessRefType.indexOf("Object") > -1 ||
      verbDefinitionResult.topLevelSuccessRefType[0] === "#"
    ) {
      pathItemObject[verbs.type].responses = {};
      pathItemObject[verbs.type].responses[
        verbDefinitionResult.topLevelSuccessCode
      ] = {
        description: "successful operation",
        content: {},
      };

      let content =
        pathItemObject[verbs.type].responses[
          verbDefinitionResult.topLevelSuccessCode
        ].content;

      let contentTypeHeader = verbs?.success?.headers?.find((value) =>
        ["content-type"].includes(value.field?.toLowerCase())
      );
      let contentTypes = contentTypeHeader?.allowedValues
        ? contentTypeHeader?.allowedValues
        : contentTypeHeader?.description
        ? [contentTypeHeader?.description]
        : ["application/json"];

      contentTypes.forEach((contentType) => {
        content[contentType] = {
          schema: {
            //  "type": verbDefinitionResult.topLevelSuccessRefType,
            //  "items": {
            $ref:
              "#/components/schemas/" + verbDefinitionResult.topLevelSuccessRef,
            //  }
          },
        };
      });

      if (
        verbs.success &&
        verbs.success.examples &&
        verbs.success.examples.length
      ) {
        verbs.success.examples.forEach(function (element, index) {
          content[getMimeFromType(element.type)] = {
            ...content[getMimeFromType(element.type)],
            examples: {
              response: {
                // TODO Rework
                summary: element.title,
                value: extractJsonFromExample(
                  element.content,
                  element.type,
                  verbDefinitionResult.topLevelSuccessRef
                ),
              },
            },
          };
        }, this);
      }
    } else {
      pathItemObject[verbs.type].responses = {};
      pathItemObject[verbs.type].responses[
        verbDefinitionResult.topLevelSuccessCode
      ] = {
        description: "successful operation",
        content: {},
      };

      let content =
        pathItemObject[verbs.type].responses[
          verbDefinitionResult.topLevelSuccessCode
        ].content;

      content[getMimeFromType(element.type)] = {
        schema: {
          type: verbDefinitionResult.topLevelSuccessRefType.toLowerCase(),
        },
      };
      // TODO here
      if (verbDefinitionResult.topLevelSuccessRefFormat) {
        content.schema.format = verbDefinitionResult.topLevelSuccessRefFormat;
      }
      if (
        verbs.success &&
        verbs.success.examples &&
        verbs.success.examples.length
      ) {
        content[getMimeFromType(element.type)]["example"] = {};
        verbs.success.examples.forEach(function (element, index) {
          content[getMimeFromType(element.type)] = {
            ...content[getMimeFromType(element.type)],
            examples: {
              response: {
                // TODO Rework
                summary: element.title,
                value: extractJsonFromExample(
                  element.content,
                  element.type,
                  verbDefinitionResult.topLevelSuccessRef
                ),
              },
            },
          };
        }, this);
      }
    }
  }

  if (
    verbDefinitionResult.topLevelErrorArray &&
    verbDefinitionResult.topLevelErrorArray.length
  ) {
    if (!pathItemObject[verbs.type].responses) {
      pathItemObject[verbs.type].responses = {};
    }
    verbDefinitionResult.topLevelErrorArray.forEach(function (item) {
      pathItemObject[verbs.type].responses[item.code] = {
        description: item.description,
      };
    });
    if (verbs.error && verbs.error.examples && verbs.error.examples.length) {
      verbs.error.examples.forEach(function (example) {
        if (!example.title) {
          console.error(
            "You must specify an example content type with {<type>}, ie: '* @apiErrorExample {json} 401 Error Response:'"
          );
        }
        var matches = example.title.match(/\d+/);
        if (matches) {
          var code = matches[0];
          if (code && pathItemObject[verbs.type].responses[code]) {
            if (!pathItemObject[verbs.type].responses[code].content) {
              pathItemObject[verbs.type].responses[code].content = {};
            }
            pathItemObject[verbs.type].responses[code].content[
              getMimeFromType(example.type)
            ] = {
              ...pathItemObject[verbs.type].responses[code].content[
                getMimeFromType(example.type)
              ],
              examples: {
                response: {
                  summary: example.title,
                  value: extractJsonFromExample(
                    example.content,
                    example.type,
                    verbDefinitionResult.topLevelSuccessRef
                  ),
                },
              },
            };
          }
        }
      });
    }
  }

  if (pathItemObject[verbs.type].parameters.length < 1) {
    delete pathItemObject[verbs.type].parameters;
  }

  if (!pathItemObject[verbs.type].description) {
    console.warn(
      `\x1b[33mwarn:\x1b[0m Operation "@apiDescription" must be present and non-empty string, for @apiName ${
        pathItemObject[verbs.type].operationId
      }`
    );
  }

  return pathItemObject;
}

function createPermission(verbs, permissions) {
  var pathItemObject = [];
  if (verbs.permission) {
    for (var i = 0; i < verbs.permission.length; i++) {
      var permission = verbs.permission[i];
      if (permission.name === "none") {
        continue;
      }

      pathItemObject.push({
        name: permission.name,
      });
      if (!permissions[permission.name]) {
        permissions[permission.name] = {
          name: permission.name,
          title: permission.title,
          description: removeTagsWithHtml2markdown(permission.description),
        };
      }
    }
  }
  return pathItemObject;
}

/**
 * Iterate through all method parameters and create array of parameter objects which are stored as security authentication
 * @param verbs
 * @returns {Array}
 */
function createSecurity(verbs, security) {
  var pathItemObject = [];
  if (verbs.header && verbs.header.fields) {
    for (var key in verbs.header.fields) {
      if (key.toLowerCase() !== "security") {
        continue;
      }
      if (verbs.header.fields.hasOwnProperty(key)) {
        for (var i = 0; i < verbs.header.fields[key].length; i++) {
          var param = verbs.header.fields[key][i];
          var field = param.field;
          var type = param.type;
          var inParam = "";
          if (param.group) {
            switch (param.group.toLowerCase()) {
              case "bearerauthorization":
                {
                  var bearerKey =
                    param.field.toLowerCase() === "authorization"
                      ? "Bearer"
                      : "Bearer-" + param.field;
                  var bearerObject = {};
                  bearerObject[bearerKey] = [];
                  pathItemObject.push(bearerObject);
                  if (!security[bearerKey]) {
                    security[bearerKey] = {
                      name: param.field,
                      in: "header",
                      type: param.type,
                      description: removeTagsWithHtml2markdown(
                        param.description
                      ),
                    };
                  }
                }
                break;
              default: {
                if (param.group.toLowerCase().startsWith("basic")) {
                  var basicKey =
                    param.field.toLowerCase() === "authorization"
                      ? "Basic"
                      : param.field
                          .split("-")
                          .map(function (w) {
                            return w.charAt(0).toUpperCase() + w.slice(1);
                          })
                          .join("");
                  var basicObject = {};
                  basicObject[basicKey] = [];
                  pathItemObject.push(basicObject);
                  if (!security[basicKey]) {
                    security[basicKey] = {
                      type: param.type,
                      description: removeTagsWithHtml2markdown(
                        param.description
                      ),
                    };

                    if (param.type !== "basic") {
                      security[basicKey] = Object.assign(security[basicKey], {
                        name: param.field,
                        in: "header",
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return pathItemObject;
}

/**
 * Iterate through all method parameters and create array of parameter objects which are stored as path parameters
 * @param verbs
 * @returns {Array}
 */
function createPathParameters(verbs, pathKeys) {
  pathKeys = pathKeys || [];

  var pathItemObject = [];
  if (verbs.parameter && verbs.parameter.fields) {
    for (var key in verbs.parameter.fields) {
      if (verbs.parameter.fields.hasOwnProperty(key)) {
        for (var i = 0; i < verbs.parameter.fields[key].length; i++) {
          var param = verbs.parameter.fields[key][i];
          var field = param.field;
          var type = param.type;
          var inParam = "";

          if (param.group && param.group.toLowerCase() === "urlparameters") {
            inParam = type === "file" ? "formData" : "path";
            pathItemObject.push({
              name: param.field,
              in: inParam,
              required: !param.optional,
              schema: { type: param.type.toLowerCase() },
              description: removeTagsWithHtml2markdown(param.description),
            });
          }
        }
      }
    }
  }
  return pathItemObject;
}

/**
 * Iterate through all method parameters and create array of parameter objects which are stored as query parameters
 * @param verbs
 * @returns {Array}
 */
function createQueryParameters(verbs, queryKeys) {
  queryKeys = queryKeys || [];

  var queryItemObject = [];
  if (verbs.parameter && verbs.parameter.fields) {
    for (var key in verbs.parameter.fields) {
      if (verbs.parameter.fields.hasOwnProperty(key)) {
        for (var i = 0; i < verbs.parameter.fields[key].length; i++) {
          var param = verbs.parameter.fields[key][i];
          var field = param.field;
          var type = param.type;
          var inParam = "";

          if (
            param.group &&
            param.group.toLowerCase() === "urlqueryparameters"
          ) {
            inParam = "query";

            var item = {
              name: param.field,
              in: inParam,
              required: !param.optional,
              schema: {
                type: param.type.toLowerCase(),
                ...extractAllowedValues(
                  param.allowedValues,
                  param.type.toLowerCase()
                ),
                ...extractDefaultValues(
                  param.defaultValue,
                  param.type.toLowerCase()
                ),
                ...convertApiDocSimpleTypeToSwaggerType(type),
              },
              description: removeTagsWithHtml2markdown(param.description),
            };

            if (param.type.toLowerCase() === "string") {
              if (param.size) {
                var sizeRegex = /^(\d*)\.\.(\d*)$/g; // ex: "4..67"
                var match = sizeRegex.exec(param.size);
                if (match && match[1]) {
                  item.schema.minLength = parseInt(match[1], 10);
                }
                if (match && match[2]) {
                  item.schema.maxLength = parseInt(match[2], 10);
                }
                if (!match && param.size.match(/\d+/)) {
                  item.schema.minLength = item.schema.maxLength = parseInt(
                    param.size,
                    10
                  );
                }
              }
            }

            if (
              param.type.toLowerCase() === "integer" ||
              param.type.toLowerCase() === "number"
            ) {
              if (param.size) {
                var sizeNumberRegex = /^(-?\d*)-(\d*)$/g; // ex: "4-67"
                var match = sizeNumberRegex.exec(param.size);
                if (match && match[1]) {
                  item.schema.minimum = parseInt(match[1], 10);
                }
                if (match && match[2]) {
                  item.schema.maximum = parseInt(match[2], 10);
                }
              }
            }

            queryItemObject.push(item);
          }
        }
      }
    }
  }
  return queryItemObject;
}

/**
 * Iterate through all method parameters and create array of parameter objects which are stored as body parameters
 * @param verbs
 * @returns {Array}
 */
function createBodyParameters(verbs, bodyKeys) {
  bodyKeys = bodyKeys || [];

  var bodyItemObject = [];
  if (verbs.parameter && verbs.parameter.fields) {
    for (var key in verbs.parameter.fields) {
      if (verbs.parameter.fields.hasOwnProperty(key)) {
        for (var i = 0; i < verbs.parameter.fields[key].length; i++) {
          var param = verbs.parameter.fields[key][i];
          var field = param.field;
          var type = param.type;
          var inParam = "";
          if (param.group && param.group.toLowerCase() === "bodyparameters") {
            inParam = "body";
            bodyItemObject.push({
              name: param.field,
              in: inParam,
              required: !param.optional,
              schema: { type: param.type.toLowerCase() },
              description: removeTagsWithHtml2markdown(param.description),
            });
          }
        }
      }
    }
  }
  return bodyItemObject;
}

/**
 * Iterate through all method parameters and create array of parameter objects which are stored as header parameters
 * @param verbs
 * @returns {Array}
 */
function createHeaderParameters(verbs, headerKeys) {
  headerKeys = headerKeys || [];

  var headerItemObject = [];
  if (verbs.parameter && verbs.parameter.fields) {
    for (var key in verbs.parameter.fields) {
      if (verbs.parameter.fields.hasOwnProperty(key)) {
        for (var i = 0; i < verbs.parameter.fields[key].length; i++) {
          var param = verbs.parameter.fields[key][i];
          var field = param.field;
          var type = param.type;
          var inParam = "";

          if (
            param.group &&
            (param.group.toLowerCase() === "headerparameters") |
              (param.group.toLowerCase() === "headersresponse")
          ) {
            inParam = "header";
            var field = Object.assign({
              name: param.field,
              in: inParam,
              required: !param.optional,
              schema: {
                type: param.type.toLowerCase(),
                ...extractAllowedValues(
                  param.allowedValues,
                  param.type.toLowerCase()
                ),
                ...extractDefaultValues(param.defaultValue),
              },
              description: removeTagsWithHtml2markdown(param.description),
            });

            headerItemObject.push(field);
          }
        }
      }
    }
  }
  if (verbs.header && verbs.header.fields) {
    for (var key in verbs.header.fields) {
      if (verbs.header.fields.hasOwnProperty(key)) {
        for (var i = 0; i < verbs.header.fields[key].length; i++) {
          var param = verbs.header.fields[key][i];
          var field = param.field;
          var type = param.type;
          var inParam = "";

          if (
            [
              "accept", // Header parameter named "Accept" are ignored. The value for the "Accept" header are defined by "response.<code>.content.<media-type>"
              "content-type", // Header parameter named "Content-Type" are ignored. The value for the "Content-Type" header are defined by "requestBody.<code>.content.<media-type>"
            ].includes(param?.field?.toLowerCase())
          ) {
            continue;
          }
          if (param.group && param.group.toLowerCase() === "header") {
            inParam = "header";
            var field = Object.assign({
              name: param.field,
              in: inParam,
              required: !param.optional,
              schema: {
                type: param.type.toLowerCase(),
                ...extractAllowedValues(
                  param.allowedValues,
                  param.type.toLowerCase()
                ),
                ...extractDefaultValues(param.defaultValue),
              },
              description: removeTagsWithHtml2markdown(param.description),
            });

            headerItemObject.push(field);
          }
        }
      }
    }
  }
  return headerItemObject;
}

/**
 * Iterate through all method parameters and create array of parameter objects which are stored as form parameters
 * @param verbs
 * @returns {Array}
 */
function createFormParameters(verbs, formKeys) {
  formKeys = formKeys || [];

  var formItemObject = [];
  if (verbs.parameter && verbs.parameter.fields) {
    for (var key in verbs.parameter.fields) {
      if (verbs.parameter.fields.hasOwnProperty(key)) {
        for (var i = 0; i < verbs.parameter.fields[key].length; i++) {
          var param = verbs.parameter.fields[key][i];
          var field = param.field;
          var type = param.type;
          var inParam = "";
          if (param.group && param.group.toLowerCase() === "formparameters") {
            inParam = "form";
            formItemObject.push({
              name: param.field,
              in: inParam,
              required: !param.optional,
              schema: { type: param.type.toLowerCase() },
              description: removeTagsWithHtml2markdown(param.description),
            });
          }
        }
      }
    }
  }
  return formItemObject;
}

/**
 * Iterate through all method parameters and create array of parameter objects which are stored as cookie parameters
 * @param verbs
 * @returns {Array}
 */
function createCookieParameters(verbs, cookieKeys) {
  cookieKeys = cookieKeys || [];

  var cookieItemObject = [];
  if (verbs.parameter && verbs.parameter.fields) {
    for (var key in verbs.parameter.fields) {
      if (verbs.parameter.fields.hasOwnProperty(key)) {
        for (var i = 0; i < verbs.parameter.fields[key].length; i++) {
          var param = verbs.parameter.fields[key][i];
          var field = param.field;
          var type = param.type;
          var inParam = "";
          if (param.group && param.group.toLowerCase() === "cookieparameters") {
            inParam = "cookie";
            cookieItemObject.push({
              name: param.field,
              in: inParam,
              required: !param.optional,
              schema: { type: param.type.toLowerCase() },
              description: removeTagsWithHtml2markdown(param.description),
            });
          }
        }
      }
    }
  }
  return cookieItemObject;
}

function groupByUrl(apidocJson) {
  return _.chain(apidocJson)
    .groupBy("url")
    .toPairs()
    .map(function (element) {
      return _.zipObject(["url", "verbs"], element);
    })
    .value();
}

module.exports = {
  toSwagger: toSwagger,
};
