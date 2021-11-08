create
    definer = root@localhost procedure SP_NodeInsert(IN _ID tinyint, IN _Name varchar(100), IN _IP varchar(100),
                                                     IN _Port smallint)
BEGIN
    if (select count(node_id) > 0
        from node
        where ip = _IP
          and port = _Port)
    then
        if (select count(node_id)
            from node
            where node_id = _ID
              and node_name != _Name
              and ip = _IP
              and port = _Port) > 0
        then
            select CONCAT('Node with ip ', _IP, ' port ', CAST(_Port AS CHAR), ' and name ',
                          (select node_name from node where node_id = _ID), ' renamed to ', _Name) as Result;
        else
            select CONCAT('Node with ip ', _IP, ' and port ', CAST(_Port AS CHAR), ' already exists') as Result;
        end if;
    else
        select CONCAT('Node with ip ', _IP, ' port ', CAST(_Port AS CHAR), ' and name ', _Name, ' inserted') as Result;
    end if;
    INSERT INTO node (node_id, node_name, ip, port)
    VALUES (_ID, _Name, _IP, _Port)
    ON DUPLICATE KEY UPDATE node_name=_Name, ip=_IP, port=_Port;
END;
